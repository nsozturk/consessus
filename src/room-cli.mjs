import fs from "node:fs";
import { isatty } from "node:tty";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { openAgentInbox } from "./agent-inbox.mjs";
import {
  formatCrossSessionEnvelope, getProcStart, sendRawUdsFrame, startPeerAgentDaemon, validateSenderMode,
} from "./index.mjs";
import { canonicalProject, createRoomIdentity, projectContains } from "./room-identity.mjs";
import { openRoomStore } from "./room-store.mjs";
import { createRooms, discussionOf, leadOf, roomText } from "./rooms.mjs";
import { listSessions } from "./sessions.mjs";
import { sendToSession } from "./send-router.mjs";
import { claudeTranscriptMark, readClaudeReply } from "./claude-replies.mjs";
import { readProfile } from "./member-profile.mjs";

export function openOwnerTty() {
  const fail = () => new Error("Room confirmation requires an operator terminal (/dev/tty)");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw fail();
  let fd;
  try { fd = fs.openSync("/dev/tty", "r+"); }
  catch { throw fail(); }
  if (!isatty(fd)) {
    fs.closeSync(fd);
    throw fail();
  }
  return fd;
}

function hasOwnerTty() {
  try { fs.closeSync(openOwnerTty()); return true; }
  catch { return false; }
}

export function readOwnerCode({ room, memberId, decision }) {
  const fd = openOwnerTty();
  try {
    fs.writeSync(fd, `Enter the confirmation code to ${decision} ${JSON.stringify(memberId)} in ${JSON.stringify(room)}: `);
    const input = Buffer.alloc(128);
    const size = fs.readSync(fd, input, 0, input.length, null);
    const line = input.subarray(0, size).toString("utf8");
    return /\r?\n$/.test(line) ? line.trim() : "";
  } finally { fs.closeSync(fd); }
}

const socketOf = endpoint => endpoint.address.slice("uds:".length);

export function sendRoomMessage(recipient, { sender, text, room, type, fromMode, lead }) {
  const messageId = randomUUID();
  const addressed = roomText({ room, sender, text, type, lead });
  return sendRawUdsFrame(socketOf(recipient), recipient.pid, {
    type: "user",
    ts: new Date().toISOString(),
    msg_id: messageId,
    room,
    room_member_id: sender.id,
    room_event: type,
    from: sender.address,
    message: { role: "user", content: formatCrossSessionEnvelope({
      text: addressed, fromAddress: sender.address, fromSessionId: sender.sessionId, fromName: sender.id, fromMode,
    }) },
    priority: "next",
  }).then(() => ({ status: "sent", messageId }));
}

export function requestJoin(controller, joiner, room) {
  return sendRawUdsFrame(socketOf(controller), controller.pid, {
    type: "control", action: "room_join", room, from: joiner.address, from_session: joiner.sessionId,
    msg_id: randomUUID(), ts: new Date().toISOString(),
  });
}

// One read of the four apps serves every delivery of a command: the Codex list alone takes about a second.
export function appChannel({ list = listSessions, send = sendToSession, ttlMs = 5000, clock = () => performance.now() } = {}) {
  const cache = new Map();
  const listApps = project => {
    const hit = cache.get(project);
    if (hit && clock() - hit.at < ttlMs) return hit.listed;
    const listed = list({ project });
    cache.set(project, { at: clock(), listed });
    return listed;
  };
  return {
    listApps,
    // The router looks the chat up again in the project's list, so a closed or moved chat is not written to.
    async sendApp(member, packet, project = member.cwd, { read = false, timeoutMs } = {}) {
      const sent = await send({ to: `${member.kind}:${member.sessionId}`, message: roomText(packet), project,
        fromName: `room ${packet.room} / ${packet.sender.id}`, list: ({ project }) => listApps(project),
        ...(read ? { read: true, timeoutMs } : {}) });
      return { status: sent.status === "delivered" ? "sent" : sent.status ?? "unreachable", ...(sent.warning ? { warning: sent.warning } : {}),
        ...(sent.reply ? { reply: sent.reply } : {}) };
    },
  };
}

// Who a command may act as when its caller has no verified session of its own. A real terminal outside any agent
// is the operator. Any other shell is only "a shell in the project folder": it can already write to every session
// with `send --to`, so a room adds no authority, but it is never admitted to a room that requires owner approval.
export function localMemberIds({ tty, requireApproval }) {
  return [...(tty ? ["local-operator"] : []), ...(requireApproval === true ? [] : ["local-shell"])];
}

// A flag given a value has swallowed the next word, and a number given none would otherwise read as 1.
export function discussOptions(args) {
  const number = key => {
    if (args[key] === undefined) return undefined;
    if (typeof args[key] !== "string") throw new Error(`--${key} takes a number`);
    return Number(args[key]);
  };
  if (args.free !== undefined && args.free !== true) throw new Error("--free is a flag");
  const seconds = number("timeout");
  if (seconds !== undefined && !(seconds > 0 && Number.isFinite(seconds))) throw new Error("--timeout takes a finite number of seconds");
  return { free: args.free === true, rounds: number("rounds"), maxMessages: number("max-messages"),
    ...(seconds ? { timeoutMs: seconds * 1000 } : {}) };
}

// room assign <room> <member>=<task> [<member>=<task> ...] [--timeout <seconds>]. Each pair is one shell word, split
// at its first "=": the parser keeps only the last of a repeated flag, so the pairs cannot be flags. A word that is
// not a pair, or a flag this command does not have, is probably part of an unquoted task: it is refused, never guessed
// at and never repeated in the error.
const ASSIGN_FLAGS = ["_", "timeout", "from-address", "from-session", "from-mode"];
export function assignOptions(args) {
  if (Object.keys(args).some(key => !ASSIGN_FLAGS.includes(key))) {
    throw new Error("room assign takes <member>=<task> words and --timeout only. Put each <member>=<task> in quotes");
  }
  const assignments = args._.slice(3).map((word, index) => {
    const cut = typeof word === "string" ? word.indexOf("=") : -1;
    if (cut < 1 || !word.slice(cut + 1).trim()) throw new Error(`Assignment ${index + 1} is not <member>=<task>. Put each <member>=<task> in quotes`);
    return { to: word.slice(0, cut), task: word.slice(cut + 1) };
  });
  if (!assignments.length) throw new Error("Use room assign <room> <member>=<task> [<member>=<task> ...]");
  if (args.timeout === undefined) return { assignments };
  const seconds = typeof args.timeout === "string" && args.timeout.trim() ? Number(args.timeout) : NaN;
  if (!(seconds > 0 && seconds <= 1800)) throw new Error("--timeout takes a number of seconds above 0, at most 1800");
  return { assignments, timeoutMs: seconds * 1000 };
}

// --discussion turns|free [--max-messages N], for room open and room set. The bounds are checked where it is stored.
export function settingOptions(args) {
  const { discussion } = args, max = args["max-messages"];
  if (discussion === undefined) {
    if (max !== undefined) throw new Error("--max-messages needs --discussion free");
    return {};
  }
  if (discussion !== "turns" && discussion !== "free") throw new Error("--discussion takes turns or free");
  if (max === undefined) return { discussion };
  if (discussion !== "free") throw new Error("--max-messages needs --discussion free");
  if (typeof max !== "string") throw new Error("--max-messages takes a number");
  return { discussion, maxMessages: Number(max) };
}

export async function handleRoomCommand(args) {
  const [, action, name, memberId] = args._;
  const from = { address: args["from-address"], sessionId: args["from-session"] };
  const fromMode = args["from-mode"];
  if (fromMode !== undefined) validateSenderMode(fromMode);
  if (args["codex-thread"] !== undefined) throw new Error("--codex-thread is no longer needed: room open attaches the project's open Codex chats itself");
  if (!["open", "join", "approve", "deny", "status", "members", "leave", "send", "discuss", "assign", "lead", "set"].includes(action)) {
    throw new Error("Use room open, join, approve, deny, status, members, leave, send, discuss, assign, lead or set");
  }
  const peers = createRoomIdentity();
  const operatorTty = async () => hasOwnerTty() && !await peers.isAgentCaller();
  if (["approve", "deny"].includes(action) && !await operatorTty()) {
    throw new Error("Room confirmation requires an operator terminal (/dev/tty) outside the agent");
  }
  const store = openRoomStore();
  const hasExplicitPeer = from.address !== undefined || from.sessionId !== undefined;
  const identity = {
    ...peers,
    async caller(project, reference) {
      try { return await peers.caller(project, reference); }
      catch (error) {
        if (hasExplicitPeer || !projectContains(project, process.cwd())) throw error;
        const room = store.readRoom(name);
        const ids = localMemberIds({ tty: await operatorTty(), requireApproval: room?.requireApproval });
        const operator = room?.members.find(p => ids.includes(p.id));
        if (!operator || operator.state !== "member" || !await peers.isLive(operator)) throw error;
        return operator;
      }
    },
  };
  const apps = appChannel();
  const rooms = createRooms({ store, identity, sendMessage: sendRoomMessage, sendJoin: requestJoin,
    // A Claude member is asked over its socket and its answer is read from its own transcript.
    askMember: async (member, packet, { timeoutMs } = {}) => {
      const session = { sessionId: member.sessionId, cwd: member.cwd };
      const offset = claudeTranscriptMark(session);
      const sent = await sendRoomMessage(member, packet);
      return { status: sent.status, reply: await readClaudeReply({ ...session, after: { msgId: sent.messageId, offset }, ...(timeoutMs ? { timeoutMs } : {}) }) };
    },
    // The roster needs each chat's profile; the router's own lookups (apps.listApps) do not pay for that read.
    listApps: project => listSessions({ project, profileOf: readProfile }),
    profileOf: member => readProfile({ app: member.kind, id: member.sessionId, path: member.cwd }),
    sendApp: (member, packet, options) => apps.sendApp(member, packet, store.readRoom(packet.room)?.project, options) });
  const summary = (room, extra = {}) => ({ room: room.room, project: room.project, lead: leadOf(room), discussion: discussionOf(room),
    members: room.members.filter(member => member.state !== "left").map(member => ({ id: member.id, state: member.state })), ...extra });
  const print = data => console.log(JSON.stringify(data, null, 2));
  if (action === "join") {
    const invited = await rooms.join(name, { project: args.project, ...from });
    for (let i = 0; i < 20; i++) {
      const member = store.readRoom(invited.room)?.members.find(p => p.id === invited.memberId);
      if (member?.state === "pending" || member?.state === "member") {
        return print({ ...invited, state: member.state });
      }
      await sleep(50);
    }
    return print({ ...invited, state: "join frame written; confirmation not observed" });
  }
  if (action === "status" || action === "members") {
    const current = rooms.status(name, { showCodes: action === "status" && await operatorTty() });
    return print(action === "members" ? current.members : current);
  }
  if (action === "approve" || action === "deny") return print(await rooms.decide(name, memberId, action, readOwnerCode));
  if (action === "leave") return print(await rooms.leave(name, from));
  // An operator terminal may change the lead and the setting without being a member; everyone else is checked in the room.
  if (action === "lead") return print(await rooms.setLead(name, memberId, { ...from, operator: await operatorTty() }));
  if (action === "set") return print(await rooms.set(name, { ...from, ...settingOptions(args), operator: await operatorTty() }));
  if (action === "assign") {
    // The first Ctrl-C stops waiting, prints what was read and releases the room; a second one quits as usual.
    const stop = new AbortController();
    const interrupt = () => { console.error("Stopping the wait. Press Ctrl-C again to quit now."); stop.abort(); };
    const options = assignOptions(args), operator = await operatorTty();
    process.once("SIGINT", interrupt);
    try {
      return print(await rooms.assign(name, { ...from, ...options, fromMode, operator, signal: stop.signal,
        onResult: result => console.error(`[${result.status}] ${result.label}: ${result.reply ?? `(${result.reason})`}`) }));
    } finally { process.off("SIGINT", interrupt); }
  }
  if (action === "discuss") {
    const options = discussOptions(args);
    // The first Ctrl-C ends a free discussion before its next delivery; a second one quits as usual.
    const stop = new AbortController();
    const interrupt = () => { console.error("Stopping before the next delivery. Press Ctrl-C again to quit now."); stop.abort(); };
    // A room set to "free" runs a free discussion without --free. Turn mode keeps the usual Ctrl-C.
    let roomIsFree = false;
    try { roomIsFree = options.rounds === undefined && discussionOf(store.readRoom(name)).mode === "free"; } catch {}
    if (options.free || roomIsFree) process.once("SIGINT", interrupt);
    try {
      return print(await rooms.discuss(name, { ...from, ...options, message: args.message, fromMode, signal: stop.signal,
        onTurn: turn => console.error(`[${turn.round ? `round ${turn.round}` : `message ${turn.n}`}] ${turn.memberId}: ${turn.reply ?? `(${turn.reason})`}`) }));
    } finally { process.off("SIGINT", interrupt); }
  }
  if (action === "send") {
    if (args.all !== undefined && args.all !== true) throw new Error("--all is a flag");
    return print(await rooms.send(name, { ...from, to: args.to, all: args.all === true, message: args.message, fromMode }));
  }

  const setting = settingOptions(args);
  const project = canonicalProject(args.project);
  const cwd = fs.realpathSync(process.cwd());
  if (!projectContains(project, cwd)) throw new Error("Run room open from the project's directory");
  let initiator, localId;
  try { initiator = await peers.caller(project, from); }
  catch (error) {
    if (hasExplicitPeer) throw error;
    localId = localMemberIds({ tty: await operatorTty(), requireApproval: args["require-approval"] === true })[0];
    if (!localId) throw new Error("A room that requires approval must be opened from a verified session or an operator terminal");
  }
  const previous = store.readRoom(name);
  if (previous && (previous.project !== project || previous.initiator !== (initiator?.id ?? localId))) {
    throw new Error("Room already belongs to a different project or initiator");
  }
  if (previous && await peers.isLive(previous.controller)) {
    return print(summary(previous, { note: "This room is already open." }));
  }
  const inbox = openAgentInbox(`room-${name}`);
  const closeInbox = () => inbox.close();
  process.once("exit", closeInbox);
  let daemon, checking = false;
  try {
    daemon = await startPeerAgentDaemon({
      name: `room-${name}`, cwd, requireAuth: true,
      onFrame(frame, rawLine) {
        inbox.append(frame, rawLine);
        if (frame?.type === "control" && frame.action === "room_join" && frame.room === name) {
          void rooms.acceptJoin(name, { address: frame.from, sessionId: frame.from_session })
            .catch(() => console.error("Room join could not be processed"));
        }
      },
    });
    const controller = { id: `controller:${daemon.sessionId}`, kind: "controller", address: `uds:${fs.realpathSync(daemon.socketPath)}`,
      sessionId: daemon.sessionId, pid: daemon.pid, cwd, procStart: getProcStart(daemon.pid) };
    await rooms.open(name, { project, controller,
      initiator: initiator ?? { ...controller, id: localId }, fromMode,
      requireApproval: args["require-approval"] === true, ...setting });
    let found = {};
    try { found = await rooms.refresh(name); }
    catch { console.error("The apps' open chats could not be read; they are tried again shortly"); }
    print(summary(store.readRoom(name), found.skipped ? { note: `Open chats of other apps were not attached: ${found.skipped}.` } : {}));
    let tick = 0;
    const heartbeat = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        await rooms.sweep(name);
        // The apps are asked far less often than the sockets: listing Codex chats alone takes about a second.
        if (++tick % 6 === 0) await rooms.refresh(name);
      }
      catch { console.error("Room liveness sweep failed"); }
      finally { checking = false; }
    }, 5000);
    heartbeat.unref();
  } catch (error) {
    daemon?.cleanup();
    inbox.close();
    process.off("exit", closeInbox);
    throw error;
  }
}
