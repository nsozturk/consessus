// A room has a lead, and the lead decides how the room talks. These tests attack three claims:
// "only the opener, the lead or an operator terminal changes the lead", "only the lead changes how the room talks",
// and "no stored setting lifts a hard cap". Every test has its own time limit, so a loop that lost its bound fails fast.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRooms, leadOf, discussionOf, roomText, MAX_FREE_MESSAGES, MAX_DISCUSSION_ROUNDS, ROOM_PEER_NOTICE } from "../src/rooms.mjs";
import { openRoomStore } from "../src/room-store.mjs";
import { settingOptions } from "../src/room-cli.mjs";

const scratch = fileURLToPath(new URL("../tmp/agent-room-lead/", import.meta.url));
fs.mkdirSync(scratch, { recursive: true });
const X = "codex:thread-1", Y = "antigravity:talk-1";
const within = { timeout: 5000 };
// The fake is bounded: past FAKE_CALLS it stops answering, so a loop that lost its limit ends instead of hanging.
const FAKE_CALLS = 80;

// A room "work": Claude sessions host (the opener), guest and other are members; so are two attached chats, a socket
// member of kind codex and the shell member "local-shell". `stranger` is a verified session that never joined.
async function room(t, { ask = false, open = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, "run-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const project = fs.realpathSync(dir);
  const endpoint = (kind, sessionId, pid) => ({ id: `${kind}:${sessionId}`, kind, sessionId, pid, cwd: project,
    address: `uds:/fixture/${pid}.sock`, procStart: "fixture-start" });
  const host = endpoint("claude", "host", 101), guest = endpoint("claude", "guest", 102), other = endpoint("claude", "other", 103);
  const socketCodex = endpoint("codex", "peer", 104), stranger = endpoint("claude", "stranger", 105);
  const shell = { ...endpoint("controller", "shell", 106), id: "local-shell" };
  const peers = [host, guest, other, socketCodex, stranger, shell];
  const data = new Map(), events = [], records = [], calls = [], live = new Set(peers.map(p => p.id));
  // The run's clock moves `step` ms with every delivery; 0 keeps time still.
  const time = { now: 0, step: 0 };
  let actor = host;
  const tx = {
    readRoom: name => structuredClone(data.get(name)),
    listRooms: () => structuredClone([...data.values()]),
    saveRoom: saved => data.set(saved.room, structuredClone(saved)),
    hasApproval: () => false,
    approveIdentity: () => {},
    appendEvent: (name, event) => events.push({ room: name, ...event }),
  };
  const store = { readRoom: tx.readRoom, listRooms: tx.listRooms, transact: callback => callback(tx) };
  const identity = {
    discover: async () => [],
    attest: async (_root, { address, sessionId }) => {
      const peer = peers.find(p => p.address === address && p.sessionId === sessionId);
      if (!peer) throw new Error("Unknown process tree");
      return peer;
    },
    caller: async () => { if (!actor) throw new Error("No verified session"); return actor; },
    isLive: async member => live.has(member.id),
  };
  const listed = { sessions: [{ app: "codex", id: "thread-1", path: project }, { app: "antigravity", id: "talk-1", path: project }], unavailable: [] };
  const answer = (member, packet, options) => {
    calls.push({ id: member.id, text: packet.text, packet, options });
    time.now += time.step;
    if (calls.length > FAKE_CALLS) return { status: "sent", reply: { status: "not-read", reason: "fixture exhausted" } };
    return { status: "sent", reply: { status: "replied", text: `${member.id} answer ${calls.length}` } };
  };
  const rooms = createRooms({ store, identity, sendJoin: async () => {}, listApps: async () => structuredClone(listed),
    sendMessage: async (recipient, packet) => { records.push({ recipient, ...packet }); return { status: "sent" }; },
    clock: () => time.now, sendApp: async (...args) => answer(...args), ...(ask ? { askMember: async (...args) => answer(...args) } : {}) });
  await rooms.open("work", { project, controller: host, initiator: host, ...open });
  await rooms.refresh("work");
  for (const peer of [guest, other, socketCodex, shell]) await rooms.acceptJoin("work", peer);
  records.length = 0;
  events.length = 0;
  const as = who => { actor = who; };
  const stored = () => data.get("work");
  const patch = change => { const next = structuredClone(stored()); change(next); data.set("work", next); };
  return { rooms, project, host, guest, other, socketCodex, stranger, shell, store, events, records, calls, live, time, as, stored, patch };
}
const leadEvents = f => f.events.filter(row => row.event === "lead");

test("the opener is the lead, and the lead is marked in the roster, in `room members` and in its own messages", within, async t => {
  const f = await room(t);
  assert.equal(f.stored().lead, f.host.id);
  const status = f.rooms.status("work");
  assert.equal(status.lead, f.host.id);
  assert.deepEqual(status.members.filter(member => member.role !== undefined).map(member => [member.id, member.role]), [[f.host.id, "room lead"]]);
  assert.match(status.members.find(member => member.id === f.host.id).label, / \(room lead\)$/);
  assert.doesNotMatch(status.members.find(member => member.id === f.guest.id).label, /room lead/);
  // The lead's message says so in the room wording, to a socket member and to an attached chat alike.
  await f.rooms.send("work", { all: true, message: "from the lead" });
  assert.equal(f.records.length, 4);
  for (const packet of [...f.records, ...f.calls.map(call => call.packet)]) {
    assert.equal(roomText(packet).split("\n")[0], `Room work, member ${f.host.id} (room lead). ${ROOM_PEER_NOTICE}`);
  }
  // The header an attached chat gets marks the lead, and only the lead.
  assert.deepEqual(f.calls[0].packet.intro.filter(line => line.includes("room lead")), [`- Claude (${f.host.id}) (room lead)`]);
  f.records.length = 0;
  f.as(f.guest);
  await f.rooms.send("work", { to: f.other.id, message: "from a member" });
  assert.equal(roomText(f.records[0]).split("\n")[0], `Room work, member ${f.guest.id}. ${ROOM_PEER_NOTICE}`);
  // The mark is set by a strict flag on the packet Consessus builds, never by anything else that is truthy.
  for (const lead of [undefined, false, "true", 1, {}]) {
    assert.equal(roomText({ room: "work", sender: { id: "claude:x" }, type: "message", text: "t", lead }).split("\n")[0], `Room work, member claude:x. ${ROOM_PEER_NOTICE}`);
  }
});

test("the opener, the current lead and an operator terminal may change the lead", within, async t => {
  const f = await room(t);
  // The opener hands the lead to a member.
  assert.deepEqual(await f.rooms.setLead("work", f.guest.id), { room: "work", lead: f.guest.id, previous: f.host.id });
  assert.equal(f.stored().lead, f.guest.id);
  // The current lead (not the opener) hands it over.
  f.as(f.guest);
  assert.deepEqual(await f.rooms.setLead("work", f.other.id), { room: "work", lead: f.other.id, previous: f.guest.id });
  // The opener (no longer lead) takes it back, naming itself by session id.
  f.as(f.host);
  assert.equal((await f.rooms.setLead("work", "host")).lead, f.host.id);
  // An operator terminal is not a member and has no verified session: it may still set the lead.
  f.as(undefined);
  assert.equal((await f.rooms.setLead("work", f.guest.id, { operator: true })).lead, f.guest.id);
  // The shell member is whoever runs a command in the folder: not even an operator terminal can make it lead.
  await assert.rejects(f.rooms.setLead("work", "local-shell", { operator: true }), /must be a verified Claude session or the operator's terminal/);
  // Every change is journaled with ids only, and announced to the socket members only.
  assert.deepEqual(leadEvents(f).map(row => [row.memberId, row.reason]), [
    [f.guest.id, "set by the opener"], [f.other.id, "handed over by the lead"], [f.host.id, "set by the opener"],
    [f.guest.id, "set from an operator terminal"]]);
  for (const row of leadEvents(f)) assert.deepEqual(Object.keys(row).sort(), ["event", "memberId", "reason", "room"]);
  const news = f.records.filter(record => record.type === "announce");
  assert.equal(news.length, 5 * 4);
  assert.equal(news[0].text, `Room work: ${f.guest.id} is room lead.`);
  assert.deepEqual(f.calls, []);
  // Naming the lead again changes nothing and is not journaled.
  const before = f.events.length;
  assert.deepEqual(await f.rooms.setLead("work", f.guest.id, { operator: true }), { room: "work", lead: f.guest.id, previous: f.guest.id });
  assert.equal(f.events.length, before);
});

test("no other caller changes the lead", within, async t => {
  const f = await room(t);
  await f.rooms.setLead("work", f.guest.id);
  const refused = async (who, pattern, options) => {
    f.as(who);
    await assert.rejects(f.rooms.setLead("work", f.other.id, options), pattern);
    assert.equal(f.stored().lead, f.guest.id);
  };
  f.records.length = 0;
  f.events.length = 0;
  // A member that is neither the opener nor the lead, even naming itself.
  await refused(f.other, /Only the room's opener, its current lead or an operator terminal/);
  // A shell in the folder and a member of another kind are not verified Claude sessions: they change no lead.
  await refused(f.shell, /Only a verified Claude session or an operator terminal/);
  await refused(f.socketCodex, /Only a verified Claude session or an operator terminal/);
  // A verified session that is not a member, and a caller with no session at all.
  await refused(f.stranger, /not a current room member/);
  await refused(undefined, /No verified session/);
  await refused(undefined, /No verified session/, { operator: false });
  await refused(undefined, /No verified session/, { operator: "true" });
  // The opener's id from another endpoint is not the opener.
  await refused({ ...f.host, pid: 999 }, /not a current room member/);
  // A former lead has no say.
  f.as(f.guest);
  await f.rooms.setLead("work", f.other.id);
  f.as(f.guest);
  await assert.rejects(f.rooms.setLead("work", f.guest.id), /Only the room's opener/);
  assert.equal(f.stored().lead, f.other.id);
  // An opener that left is not a member any more.
  f.as(f.host);
  await f.rooms.leave("work");
  await assert.rejects(f.rooms.setLead("work", f.host.id), /not a current room member/);
  assert.equal(leadEvents(f).length, 1);
});

test("the new lead must be a current member that can act for itself; an attached chat is refused with the reason", within, async t => {
  const f = await room(t);
  for (const options of [{}, { operator: true }]) {
    await assert.rejects(f.rooms.setLead("work", X, options), /An attached chat cannot be room lead: it has no session of its own to run a command from/);
    await assert.rejects(f.rooms.setLead("work", "talk-1", options), /An attached chat cannot be room lead/);
    await assert.rejects(f.rooms.setLead("work", f.socketCodex.id, options), /must be a verified Claude session or the operator's terminal/);
    await assert.rejects(f.rooms.setLead("work", f.stranger.id, options), /not a unique current room member/);
    await assert.rejects(f.rooms.setLead("work", "", options), /Use room lead <room> <member>/);
    await assert.rejects(f.rooms.setLead("work", undefined, options), /Use room lead <room> <member>/);
  }
  f.as(f.other);
  await f.rooms.leave("work");
  f.as(f.host);
  await assert.rejects(f.rooms.setLead("work", f.other.id), /not a unique current room member/);
  assert.equal(f.stored().lead, f.host.id);
  assert.deepEqual(leadEvents(f), []);
  // A member's text never reaches an error or the journal: errors name no id at all.
  await assert.rejects(f.rooms.setLead("work", "secret words of a member"), error => !/secret/.test(error.message));
});

test("when the lead leaves or stops answering, the lead falls back to the opener", within, async t => {
  const f = await room(t);
  await f.rooms.setLead("work", f.guest.id);
  f.events.length = 0; f.records.length = 0;
  f.as(f.guest);
  await f.rooms.leave("work");
  assert.equal(f.stored().lead, f.host.id);
  assert.deepEqual(leadEvents(f).map(row => [row.memberId, row.reason]), [[f.host.id, "the lead left"]]);
  assert.ok(f.records.some(record => record.type === "announce" && record.text === `Room work: ${f.host.id} is room lead.`));
  // A member that leaves without being lead changes nothing.
  f.events.length = 0;
  f.as(f.shell);
  await f.rooms.leave("work");
  assert.deepEqual(leadEvents(f), []);
  // A lead whose process died is swept out, and the opener leads again.
  f.as(f.host);
  await f.rooms.setLead("work", f.other.id);
  f.events.length = 0; f.records.length = 0;
  f.live.delete(f.other.id);
  await f.rooms.sweep("work");
  assert.equal(f.stored().lead, f.other.id);
  await f.rooms.sweep("work");
  assert.equal(f.stored().lead, f.host.id);
  assert.deepEqual(leadEvents(f).map(row => [row.memberId, row.reason]), [[f.host.id, "the lead left"]]);
  assert.ok(f.records.some(record => record.text === `Room work: ${f.host.id} is room lead.`));
  // The opener leaving while it leads leaves the lead with the opener: nobody inherits it.
  f.events.length = 0;
  await f.rooms.leave("work");
  assert.equal(f.stored().lead, f.host.id);
  assert.deepEqual(leadEvents(f), []);
  assert.equal(f.rooms.status("work").members.some(member => member.role), false);
});

test("a lead that leaves after the opener left: the room goes back to the opener, and nobody is announced as lead", within, async t => {
  const f = await room(t);
  await f.rooms.setLead("work", f.guest.id);
  await f.rooms.leave("work");
  f.events.length = 0; f.records.length = 0;
  f.as(f.guest);
  await f.rooms.leave("work");
  assert.equal(f.stored().lead, f.host.id);
  assert.deepEqual(leadEvents(f).map(row => [row.memberId, row.reason]), [[f.host.id, "the lead left"]]);
  assert.deepEqual(f.records.filter(record => /room lead/.test(record.text)), []);
  assert.equal(f.rooms.status("work").members.some(member => member.role), false);
  // An operator terminal can still name a lead in such a room.
  f.as(undefined);
  assert.equal((await f.rooms.setLead("work", f.other.id, { operator: true })).lead, f.other.id);
});

test("a stored lead is checked each time it is read: one that is not an eligible current member means the opener", within, async t => {
  const f = await room(t);
  for (const lead of [X, f.socketCodex.id, f.stranger.id, "", 7, null, ["claude:guest"], { id: f.guest.id }]) {
    f.patch(next => { next.lead = lead; });
    assert.equal(leadOf(f.stored()), f.host.id);
    assert.equal(f.rooms.status("work").lead, f.host.id);
  }
  // A chat stays a chat whatever kind the file gives it.
  f.patch(next => { next.lead = X; next.members.find(member => member.id === X).kind = "claude"; });
  assert.equal(leadOf(f.stored()), f.host.id);
  f.patch(next => { next.lead = f.guest.id; next.members.find(member => member.id === f.guest.id).state = "left"; });
  assert.equal(leadOf(f.stored()), f.host.id);
  f.patch(next => { next.lead = f.other.id; });
  assert.equal(leadOf(f.stored()), f.other.id);
  // An opener that is not a verified Claude session does not lead: with no eligible stored lead the room has none,
  // and that opener cannot name one, itself included.
  f.patch(next => { next.initiator = f.socketCodex.id; next.lead = f.other.id; });
  assert.equal(leadOf(f.stored()), f.other.id);
  f.patch(next => { delete next.lead; });
  assert.equal(leadOf(f.stored()), null);
  assert.equal(f.rooms.status("work").lead, null);
  f.as(f.socketCodex);
  await assert.rejects(f.rooms.setLead("work", f.socketCodex.id), /This room has no lead/);
  f.patch(next => { next.initiator = "local-shell"; });
  f.as(f.shell);
  await assert.rejects(f.rooms.setLead("work", f.other.id), /This room has no lead/);
  await assert.rejects(f.rooms.assign("work", { assignments: [{ to: f.other.id, task: "t" }] }), /This room has no lead/);
  await assert.rejects(f.rooms.set("work", { discussion: "free" }), /This room has no lead/);
  assert.equal((await f.rooms.setLead("work", f.other.id, { operator: true })).lead, f.other.id);
  f.patch(next => { next.initiator = f.host.id; delete next.lead; });
  f.as(f.host);
  assert.equal(leadOf(f.stored()), f.host.id);
  f.patch(next => { next.lead = f.other.id; });
  f.as(f.host);
  // A room written before rooms had a lead.
  f.patch(next => { delete next.lead; });
  assert.equal(leadOf(f.stored()), f.host.id);
  // A chat that was written in as lead does not get the lead's rights or its mark.
  f.patch(next => { next.lead = X; });
  f.as(f.other);
  await assert.rejects(f.rooms.set("work", { discussion: "free" }), /Only the room lead or an operator terminal/);
  f.as(f.host);
  assert.deepEqual((await f.rooms.set("work", { discussion: "free" })).discussion, { mode: "free" });
});

test("a change of lead reaches an attached chat with the next message, in the roster header", within, async t => {
  const f = await room(t);
  await f.rooms.send("work", { to: X, message: "one" });
  await f.rooms.send("work", { to: X, message: "two" });
  assert.ok(f.calls[0].packet.intro);
  assert.equal(f.calls[1].packet.intro, undefined);
  await f.rooms.setLead("work", f.guest.id);
  await f.rooms.send("work", { to: X, message: "three" });
  assert.deepEqual(f.calls[2].packet.intro.filter(line => line.includes("room lead")), [`- Claude (${f.guest.id}) (room lead)`]);
  assert.equal(roomText(f.calls[2].packet).split("\n")[0], `Room work, member ${f.host.id}. ${ROOM_PEER_NOTICE}`);
});

test("the lead or an operator terminal sets how the room talks; nobody else does", within, async t => {
  const f = await room(t, { open: { discussion: "free", maxMessages: 6 } });
  assert.deepEqual(f.stored().discussion, { mode: "free", maxMessages: 6 });
  assert.deepEqual(f.rooms.status("work").discussion, { mode: "free", maxMessages: 6 });
  assert.deepEqual(await f.rooms.set("work", { discussion: "turns" }), { room: "work", discussion: { mode: "turns" } });
  assert.deepEqual(f.stored().discussion, { mode: "turns" });
  await f.rooms.setLead("work", f.guest.id);
  f.events.length = 0;
  // The opener is not the lead any more.
  await assert.rejects(f.rooms.set("work", { discussion: "free" }), /Only the room lead or an operator terminal/);
  for (const who of [f.other, f.shell, f.socketCodex]) {
    f.as(who);
    await assert.rejects(f.rooms.set("work", { discussion: "free" }), /Only the room lead or an operator terminal/);
  }
  f.as(f.stranger);
  await assert.rejects(f.rooms.set("work", { discussion: "free" }), /not a current room member/);
  f.as(undefined);
  await assert.rejects(f.rooms.set("work", { discussion: "free" }), /No verified session/);
  await assert.rejects(f.rooms.set("work", { discussion: "free", operator: "true" }), /No verified session/);
  assert.deepEqual(f.stored().discussion, { mode: "turns" });
  assert.deepEqual(f.events, []);
  assert.deepEqual((await f.rooms.set("work", { discussion: "free", maxMessages: MAX_FREE_MESSAGES, operator: true })).discussion, { mode: "free", maxMessages: MAX_FREE_MESSAGES });
  f.as(f.guest);
  assert.deepEqual((await f.rooms.set("work", { discussion: "free", maxMessages: 4 })).discussion, { mode: "free", maxMessages: 4 });
  assert.deepEqual(f.events.map(row => [row.event, row.memberId, row.status]), [
    ["set", undefined, `discussion: free, at most ${MAX_FREE_MESSAGES} messages`], ["set", f.guest.id, "discussion: free, at most 4 messages"]]);
  // Values that are not a setting are refused on write, by the lead too.
  for (const bad of [{ discussion: "loud" }, { discussion: true }, {}, { discussion: "turns", maxMessages: 4 },
    { discussion: "free", maxMessages: 0 }, { discussion: "free", maxMessages: MAX_FREE_MESSAGES + 1 }, { discussion: "free", maxMessages: 2.5 },
    { discussion: "free", maxMessages: "4" }, { discussion: "free", maxMessages: Infinity }, { discussion: "free", maxMessages: NaN }]) {
    await assert.rejects(f.rooms.set("work", bad), /--discussion takes turns or free|--max-messages/);
  }
  assert.deepEqual(f.stored().discussion, { mode: "free", maxMessages: 4 });
});

test("a room cannot be opened with a setting that is not one", within, async t => {
  for (const open of [{ discussion: "loud" }, { discussion: "free", maxMessages: 21 }, { discussion: "turns", maxMessages: 3 }, { maxMessages: 3 }]) {
    await assert.rejects(room(t, { open }), /--discussion takes turns or free|--max-messages/);
  }
});

test("a discussion follows the room's setting, and any member may start one in that mode", within, async t => {
  const f = await room(t);
  f.as(f.guest);
  assert.equal((await f.rooms.discuss("work", { message: "m" })).turns.length, 2);
  assert.equal((await f.rooms.discuss("work", { message: "m", rounds: 2 })).turns.length, 4);
  // A member's motion does not carry the lead's mark.
  assert.equal(f.calls.length, 6);
  assert.ok(f.calls.every(call => call.packet.lead === undefined));
  f.as(f.host);
  await f.rooms.set("work", { discussion: "free", maxMessages: 5 });
  f.calls.length = 0;
  f.as(f.guest);
  const free = await f.rooms.discuss("work", { message: "m" });
  assert.equal(free.free, true);
  assert.equal(free.maxMessages, 5);
  assert.equal(f.calls.length, 5);
  // A member may ask for fewer deliveries than the room allows, or say --free where the room is free already.
  f.calls.length = 0;
  assert.equal((await f.rooms.discuss("work", { message: "m", free: true, maxMessages: 3 })).deliveries.length, 3);
  assert.equal((await f.rooms.discuss("work", { message: "m", maxMessages: 5 })).deliveries.length, 5);
  // Without a stored budget the default applies.
  f.as(f.host);
  await f.rooms.set("work", { discussion: "free" });
  f.calls.length = 0;
  f.as(f.other);
  assert.equal((await f.rooms.discuss("work", { message: "m" })).deliveries.length, 8);
});

test("only the lead overrides the room's mode or raises its budget for one run", within, async t => {
  const f = await room(t);
  const refused = async (who, options, pattern) => {
    f.as(who);
    await assert.rejects(f.rooms.discuss("work", { message: "m", ...options }), pattern);
    assert.deepEqual(f.calls, []);
    assert.equal(f.stored().discussing, undefined);
    assert.deepEqual(f.events.filter(row => row.event === "discuss"), []);
  };
  // A "turns" room: --free is the lead's alone.
  for (const who of [f.guest, f.other, f.shell]) await refused(who, { free: true }, /Only the room lead may run a free discussion in a room set to turns/);
  await refused(f.guest, { free: true, maxMessages: 2 }, /Only the room lead/);
  await refused(f.guest, { maxMessages: 2 }, /--max-messages needs --free/);
  await refused(f.host, { maxMessages: 2 }, /--max-messages needs --free/);
  f.as(f.host);
  const run = await f.rooms.discuss("work", { message: "m", free: true, maxMessages: 2 });
  assert.equal(run.free, true);
  assert.equal(f.calls.length, 2);
  // The override is for one run: the room stays as it was.
  assert.deepEqual(discussionOf(f.stored()), { mode: "turns" });
  // A "free" room with a budget of 4: turns, or more than 4, are the lead's alone.
  await f.rooms.set("work", { discussion: "free", maxMessages: 4 });
  f.calls.length = 0; f.events.length = 0;
  await refused(f.guest, { rounds: 1 }, /Only the room lead may run turns in a room set to free/);
  await refused(f.guest, { maxMessages: 5 }, /Only the room lead may go above the room's 4 messages/);
  await refused(f.guest, { free: true, maxMessages: MAX_FREE_MESSAGES }, /Only the room lead may go above/);
  await refused(f.guest, { free: true, rounds: 1 }, /--rounds cannot be used with --free/);
  f.as(f.host);
  assert.equal((await f.rooms.discuss("work", { message: "m", rounds: 1 })).turns.length, 2);
  assert.equal((await f.rooms.discuss("work", { message: "m", maxMessages: 6 })).deliveries.length, 6);
  // The lead is who the room says now, not who opened it.
  await f.rooms.setLead("work", f.guest.id);
  f.calls.length = 0; f.events.length = 0;
  await refused(f.host, { rounds: 1 }, /Only the room lead/);
  f.as(f.guest);
  assert.equal((await f.rooms.discuss("work", { message: "m", rounds: 1 })).turns.length, 2);
});

const HOSTILE_BUDGETS = [1e999, 1000, MAX_FREE_MESSAGES + 1, "1000", "20", 0, -1, 20.5, NaN, null, [20], { n: 5 }, true];

test("the hard caps hold whatever a room file says: a hostile stored budget or mode is not followed", { timeout: 20000 }, async t => {
  for (const maxMessages of HOSTILE_BUDGETS) {
    const f = await room(t);
    f.patch(next => { next.discussion = { mode: "free", maxMessages }; });
    assert.deepEqual(discussionOf(f.stored()), { mode: "free" });
    // Lead and plain member alike: the stored number is not a number Consessus set, so the default applies.
    for (const who of [f.host, f.guest]) {
      f.calls.length = 0;
      f.as(who);
      const result = await f.rooms.discuss("work", { message: "m" });
      assert.equal(result.maxMessages, 8);
      assert.equal(f.calls.length, 8);
      assert.ok(f.calls.length <= MAX_FREE_MESSAGES);
    }
    // No caller can ask for more than the cap in such a room either.
    await assert.rejects(f.rooms.discuss("work", { message: "m", maxMessages: MAX_FREE_MESSAGES + 1 }), /--max-messages must be a whole number, at most 20/);
    f.as(f.host);
    await assert.rejects(f.rooms.discuss("work", { message: "m", maxMessages: 1e999 }), /--max-messages must be a whole number, at most 20/);
  }
  for (const discussion of ["free", { mode: "FREE" }, { mode: ["free"] }, { mode: "free ", maxMessages: 3 }, [], 5, null, { mode: "turns", rounds: 99 }]) {
    const f = await room(t);
    f.patch(next => { next.discussion = discussion; });
    assert.deepEqual(discussionOf(f.stored()), { mode: "turns" });
    const result = await f.rooms.discuss("work", { message: "m" });
    assert.equal(result.rounds, 1);
    assert.equal(f.calls.length, 2);
  }
  // A "free" room does not lift the rounds cap, the room lock or the time limit of a run.
  const f = await room(t);
  await f.rooms.set("work", { discussion: "free", maxMessages: MAX_FREE_MESSAGES });
  await assert.rejects(f.rooms.discuss("work", { message: "m", rounds: MAX_DISCUSSION_ROUNDS + 1 }), /--rounds must be a whole number from 1 to 5/);
  assert.equal((await f.rooms.discuss("work", { message: "m" })).deliveries.length, MAX_FREE_MESSAGES);
  // The run's time limit: once 300 seconds have passed, no further delivery is made, whatever budget is left.
  f.calls.length = 0;
  f.time.step = 300_001;
  const late = await f.rooms.discuss("work", { message: "m" });
  assert.equal(late.stopped, "time");
  assert.equal(f.calls.length, 1);
  f.time.step = 0;
  f.patch(next => { next.discussing = { token: "someone-else", until: Date.now() + 60_000 }; });
  f.calls.length = 0;
  await assert.rejects(f.rooms.discuss("work", { message: "m" }), /Another discussion is running/);
  assert.deepEqual(f.calls, []);
});

test("a room file with a lead or a setting that is not valid is refused when it is read", within, t => {
  const dir = fs.mkdtempSync(path.join(scratch, "store-"));
  const previousHome = process.env.CONSESSUS_HOME;
  process.env.CONSESSUS_HOME = path.join(dir, "home");
  t.after(() => {
    if (previousHome === undefined) delete process.env.CONSESSUS_HOME; else process.env.CONSESSUS_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = { room: "demo", project: fs.realpathSync(dir), controller: { address: "uds:/fixture/control.sock", pid: 42, sessionId: "fixture-session" },
    initiator: "claude:fixture-session", members: [], ts: "2026-01-01T00:00:00.000Z" };
  const store = openRoomStore();
  for (const good of [{}, { lead: "claude:guest" }, { discussion: { mode: "turns" } }, { discussion: { mode: "free" } },
    { lead: "local-shell", discussion: { mode: "free", maxMessages: MAX_FREE_MESSAGES } }, { discussion: { mode: "free", maxMessages: 1 } }]) {
    store.transact(tx => tx.saveRoom({ ...base, ...good }));
    assert.deepEqual(store.readRoom("demo"), { ...base, ...good });
  }
  const file = path.join(process.env.CONSESSUS_HOME, "rooms", "demo.json");
  const bad = [{ lead: "" }, { lead: 7 }, { lead: null }, { lead: ["claude:guest"] }, { discussion: "free" }, { discussion: null }, { discussion: [] },
    { discussion: {} }, { discussion: { mode: "loud" } }, { discussion: { mode: "turns", maxMessages: 3 } },
    ...HOSTILE_BUDGETS.filter(value => !Number.isNaN(value) && value !== 1e999).map(maxMessages => ({ discussion: { mode: "free", maxMessages } }))];
  for (const change of bad) {
    fs.writeFileSync(file, JSON.stringify(base) + "\n", { mode: 0o600 });
    assert.throws(() => store.transact(tx => tx.saveRoom({ ...base, ...change })), /Invalid room state/);
    // The same value written into the file by something else is refused on read.
    fs.writeFileSync(file, JSON.stringify({ ...base, ...change }) + "\n", { mode: 0o600 });
    assert.throws(() => store.readRoom("demo"), /Invalid room state/);
  }
  // 1e999 is valid JSON text for a number no room may hold.
  fs.writeFileSync(file, JSON.stringify({ ...base, discussion: { mode: "free", maxMessages: 7 } }).replace(":7}", ":1e999}") + "\n", { mode: 0o600 });
  assert.throws(() => store.readRoom("demo"), /Invalid room state/);
});

test("in a discussion the lead speaks first when it is among the speakers", within, async t => {
  const f = await room(t, { ask: true });
  // Speakers in room order: the two chats, then guest and other (Claude sessions that can be asked). The host calls.
  const order = () => f.calls.splice(0).map(call => call.id);
  const natural = [X, Y, f.guest.id, f.other.id];
  await f.rooms.discuss("work", { message: "m" });
  assert.deepEqual(order(), natural);
  await f.rooms.setLead("work", f.other.id);
  await f.rooms.discuss("work", { message: "m", rounds: 2 });
  const leadFirst = [f.other.id, X, Y, f.guest.id];
  assert.deepEqual(order(), [...leadFirst, ...leadFirst]);
  // Free mode: the motion goes to the lead first as well. The opener is not the lead now, so the room is set by an operator.
  await f.rooms.set("work", { discussion: "free", maxMessages: 4, operator: true });
  await f.rooms.discuss("work", { message: "m" });
  assert.deepEqual(order(), leadFirst);
  // A lead that is the caller is not a speaker: the order is the room's.
  f.as(f.other);
  await f.rooms.discuss("work", { message: "m", rounds: 1 });
  assert.deepEqual(order(), [f.host.id, X, Y, f.guest.id]);
});

test("--discussion and --max-messages are read strictly from the command line", () => {
  assert.deepEqual(settingOptions({}), {});
  assert.deepEqual(settingOptions({ discussion: "free" }), { discussion: "free" });
  assert.deepEqual(settingOptions({ discussion: "turns" }), { discussion: "turns" });
  assert.deepEqual(settingOptions({ discussion: "free", "max-messages": "12" }), { discussion: "free", maxMessages: 12 });
  for (const args of [{ discussion: true }, { discussion: "loud" }, { discussion: "" }]) assert.throws(() => settingOptions(args), /--discussion takes turns or free/);
  assert.throws(() => settingOptions({ discussion: "free", "max-messages": true }), /--max-messages takes a number/);
  assert.throws(() => settingOptions({ "max-messages": "4" }), /--max-messages needs --discussion free/);
  assert.throws(() => settingOptions({ discussion: "turns", "max-messages": "4" }), /--max-messages needs --discussion free/);
});
