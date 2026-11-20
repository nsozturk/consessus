import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isPidAlive, listLiveSessions } from "./index.mjs";
import { connectAntigravity, workspaceUris } from "./antigravity-delivery.mjs";
import { sessionMode, modeHint } from "./permission-modes.mjs";
import { opencodeRegistration, readOpencodeService } from "./opencode-delivery.mjs";
import { codexRecords, sanitizeProfile } from "./member-profile.mjs";

const MAX_FRAME = 1024 * 1024;
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

async function processCommands(pids) {
  const { execFile } = await import("node:child_process");
  return new Promise(resolve => execFile("/bin/ps", ["-ww", "-o", "pid=,command=", "-p", pids.join(",")], { timeout: 4000 },
    (_error, stdout = "") => resolve(new Map(stdout.split("\n").map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
      .map(match => [Number(match[1]), match[2]])))));
}

// A Consessus listener registers itself the way a Claude session does, so Claude can message it.
// It is a mailbox for another app, not a model, and is shown as such.
export async function claudeSource({ list = listLiveSessions, commands = processCommands } = {}) {
  const sessions = await list();
  const running = sessions.length ? await commands(sessions.map(session => session.pid)) : new Map();
  return sessions.map(session => ({
    id: session.sessionId, path: session.cwd ?? null,
    status: /^(?:\S*\/)?node\s+(?:\S*\/)?(?:consessus|claude-peer|cc-peer-bridge)(?:\.mjs)?\s+(?:agent|room)\b/.test(running.get(session.pid) ?? "") ? "listener" : session.status ?? "unknown",
    title: session.name ?? "", address: session.messagingSocketPath ? `uds:${session.messagingSocketPath}` : undefined,
  }));
}

// The desktop app has no list request. After `initialize` it tells a new client which
// chats a window is showing, so listening briefly is the list.
export function codexOpenThreads({ socketPath = path.join(codexHome(), "ipc", "ipc.sock"), windowMs = 900 } = {}) {
  return new Promise((resolve, reject) => {
    const open = new Set();
    let buffer = Buffer.alloc(0), timer;
    const fail = () => { clearTimeout(timer); socket.destroy(); reject(new Error("Codex desktop is not running or its local socket is unavailable")); };
    const send = message => {
      const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      socket.write(Buffer.concat([head, body]));
    };
    let stat;
    try { stat = fs.lstatSync(socketPath); } catch {}
    if (!stat?.isSocket() || stat.uid !== process.getuid()) { reject(new Error("Codex desktop is not running or its local socket is unavailable")); return; }
    const socket = net.connect(socketPath);
    socket.on("error", fail);
    socket.on("connect", () => {
      send({ type: "request", requestId: randomUUID(), sourceClientId: "initializing-client", version: 0,
        method: "initialize", params: { clientType: "claude-peer" }, timeoutMs: 12000 });
      timer = setTimeout(() => { socket.destroy(); resolve([...open]); }, windowMs);
    });
    let skip = 0;
    socket.on("data", chunk => {
      const dropped = Math.min(skip, chunk.length);
      skip -= dropped;
      buffer = Buffer.concat([buffer, chunk.subarray(dropped)]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        // Big frames are other chats' content: dropped unread so memory stays bounded.
        if (size > MAX_FRAME) { const n = Math.min(size, buffer.length - 4); skip = size - n; buffer = buffer.subarray(4 + n); continue; }
        if (buffer.length < 4 + size) break;
        let message;
        try { message = JSON.parse(buffer.subarray(4, 4 + size)); } catch { return fail(); }
        buffer = buffer.subarray(4 + size);
        // Only this observer's own bookkeeping is read. Other broadcasts carry chat text and are dropped unread.
        if (message?.type === "client-discovery-request") {
          send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
        } else if (message?.type === "broadcast" && message.method === "thread-stream-following-changed") {
          const id = message.params?.conversationId;
          if (typeof id === "string") message.params.following === true ? open.add(id) : open.delete(id);
        }
      }
    });
  });
}

// `records: true` (every source takes it) adds `record`: what the app's own list says about a session's model.
// listSessions hands it to the profile reader and never passes it on.
async function codexSource({ records = false } = {}) {
  const ids = await codexOpenThreads();
  if (!ids.length) return [];
  const rows = await codexRecords(ids, { home: codexHome() });
  return ids.map(id => ({ id, path: rows.get(id)?.cwd ?? null, status: "open", title: rows.get(id)?.title ?? "",
    ...(records && rows.has(id) ? { record: rows.get(id) } : {}) }));
}

export async function antigravitySource({ records = false, ...connection } = {}) {
  const { listed, call } = await connectAntigravity(connection);
  return Object.entries(listed).map(([id, summary]) => {
    const uri = workspaceUris(summary)[0];
    let folder = null;
    try { folder = uri ? fileURLToPath(uri) : null; } catch {}
    return { id, path: folder, status: summary?.status === "CASCADE_RUN_STATUS_RUNNING" ? "running" : "idle", title: summary?.summary ?? "",
      // Only the steps from `offset` on are asked for: the model is on each step, the conversation is not wanted.
      ...(records ? { record: { stepCount: summary?.stepCount,
        steps: async offset => (await call("GetCascadeTrajectorySteps", { cascadeId: id, stepOffset: offset }))?.steps } } : {}) };
  });
}

// The OpenCode 2.x background service writes this owner-only file for its own clients.
// The desktop 1.x app has no such file; its sessions are reachable only from inside the app.
export async function opencodeSource({ registration = opencodeRegistration(), isAlive = isPidAlive, request = fetch,
  recentMs = 12 * 3600_000, records = false } = {}) {
  const { origin, headers } = readOpencodeService({ registration, isAlive });
  const get = async route => {
    const reply = await request(`${origin}${route}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!reply.ok) throw new Error(`OpenCode service answered HTTP ${reply.status}`);
    return (await reply.json())?.data;
  };
  const [sessions, active] = await Promise.all([get("/api/session?limit=50"), get("/api/session/active").catch(() => ({}))]);
  // The service keeps every past session. Only busy ones and those touched in the last twelve hours count as open.
  const busy = id => Boolean(active) && Object.hasOwn(active, id);
  const fresh = session => busy(session.id) || Date.now() - Number(session.time?.updated ?? 0) < recentMs;
  return (Array.isArray(sessions) ? sessions : []).filter(fresh).map(session => ({
    id: session.id, path: session.location?.directory ?? null,
    status: busy(session.id) ? "busy" : "idle", title: session.title ?? "",
    ...(records ? { record: { model: session.model?.id, provider: session.model?.providerID, effort: session.model?.variant } } : {}),
  }));
}

export const defaultSources = () => [["claude", claudeSource], ["codex", codexSource], ["antigravity", antigravitySource], ["opencode", opencodeSource]];

// `profileOf` (see member-profile.mjs) is asked only by a caller that shows or stores profiles: it reads the
// apps' own records, so a plain lookup of who is open does not pay for it.
export async function listSessions({ project, sources = defaultSources(), modeOf = sessionMode, profileOf } = {}) {
  const root = project === undefined ? undefined : fs.realpathSync.native(project);
  const inside = folder => {
    if (!root) return true;
    if (typeof folder !== "string" || !path.isAbsolute(folder)) return false;
    let real = folder;
    try { real = fs.realpathSync.native(folder); } catch {}
    const relative = path.relative(root, real);
    // macOS only: relative() between two absolute paths is never absolute, and "" is the root itself.
    return relative !== ".." && !relative.startsWith(`..${path.sep}`);
  };
  const results = await Promise.all(sources.map(async ([app, source]) => {
    try {
      const rows = await source(profileOf ? { records: true } : undefined);
      if (!Array.isArray(rows)) return { app, reason: "returned no session list" };
      return { app, rows: rows.filter(row => row && typeof row === "object") };
    } catch (error) { return { app, reason: error?.message ?? "unavailable" }; }
  }));
  return {
    sessions: await Promise.all(results.flatMap(result => (result.rows ?? []).filter(row => inside(row.path)).map(async ({ record, ...row }) => {
      let profile;
      if (profileOf) {
        let read;
        try { read = await profileOf({ app: result.app, id: row.id, path: row.path, title: row.title, record }); } catch {}
        profile = sanitizeProfile(result.app, read);
      }
      // The mode is read, never set: it tells the sender whether a message may wait for approval.
      let mode = profile?.mode;
      try { mode ??= modeOf(result.app, row.id); } catch {}
      return { app: result.app, ...row, mode: mode?.mode ?? "unknown", asks: mode?.asks ?? "unknown", ...(profile ? { profile } : {}) };
    }))),
    unavailable: results.filter(result => result.reason).map(({ app, reason }) => ({ app, reason })),
  };
}

// Terminal controls, Unicode line breaks and bidi overrides would let a title rewrite or reorder the output.
export const plainText = text => String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");

export function formatSessions({ sessions, unavailable }) {
  const lines = sessions.length ? [] : ["No sessions found."];
  if (sessions.length) {
    const label = row => !row.mode || row.mode === "unknown" ? "-"
      : row.asks === "always" ? `${row.mode} (asks)` : row.asks === "sometimes" ? `${row.mode} (may ask)` : row.mode;
    const model = ({ id, effort } = {}) => !id || id === "unknown" ? "-" : effort ? `${id} [${effort}]` : id;
    const shown = sessions.map(row => ({ ...row, path: row.path ?? "-", mode: label(row), model: model(row.profile?.model) }));
    const size = key => Math.max(key.length, ...shown.map(row => plainText(row[key]).length));
    const cols = ["app", "status", "mode", "model", "id", "path"].map(key => [key, size(key)]);
    lines.push([...cols.map(([key, n]) => key.toUpperCase().padEnd(n)), "TITLE"].join("  "));
    for (const row of shown) {
      lines.push([...cols.map(([key, n]) => plainText(row[key]).padEnd(n)), plainText(row.title).slice(0, 60)].join("  ").trimEnd());
    }
  }
  for (const app of new Set(sessions.filter(row => row.asks === "always" || row.asks === "sometimes").map(row => row.app))) {
    lines.push(`${app}: a message may wait for approval there. ${modeHint(app)}`);
  }
  for (const { app, reason } of unavailable) lines.push(`${app}: not available (${plainText(reason)})`);
  return lines.join("\n") + "\n";
}
