import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
const sqlite = await import("node:sqlite").catch(() => null);
const { DatabaseSync } = sqlite || {};
const relayTest = (name, fn) => test(name, { skip: !sqlite && "Optional relay requires node:sqlite (Node 22.13+ or 24+)" }, fn);
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const threadId = "11111111-2222-4333-8444-555555555555";

function fixture(t) {
  fs.mkdirSync(path.join(root, "tmp/agent-peer-public-sync"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "tmp/agent-peer-public-sync/r-"));
  const codexBin = path.join(dir, "codex");
  const calls = path.join(dir, "calls.jsonl");
  fs.writeFileSync(codexBin, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log('Queued message fake-queue-id');\nprocess.exit(fs.existsSync(${JSON.stringify(path.join(dir, "fail"))})?1:0);\n`, { mode: 0o700 });
  const f = { dir, codexBin, calls, dbPath: path.join(dir, "raw.sqlite"),
    target: { sessionId: "source-session", messagingSocketPath: path.join(dir, "source.sock") },
    relays: [], child: null };
  t.after(async () => {
    if (f.child && f.child.exitCode === null && f.child.signalCode === null) {
      const stopped = new Promise((resolve) => f.child.once("exit", resolve));
      f.child.kill("SIGTERM"); await stopped;
    }
    for (const relay of f.relays) relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}

async function open(f, extra = {}) {
  const modulePath = path.join(root, "src/codex-relay.mjs");
  assert.ok(fs.existsSync(modulePath), "the reusable Codex relay module is not implemented");
  const { openCodexRelay } = await import(pathToFileURL(modulePath));
  const relay = openCodexRelay({ threadId, target: f.target, dbPath: f.dbPath,
    codexBin: f.codexBin, log: () => {}, ...extra });
  f.relays.push(relay); return relay;
}

function message(f, id = "message-1", content = "Hello from Claude") {
  return { type: "user", msg_id: id, from: "uds:" + f.target.messagingSocketPath,
    message: { role: "user", content } };
}

function callRows(f) {
  return fs.existsSync(f.calls) ? fs.readFileSync(f.calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

function statuses(f) {
  const db = new DatabaseSync(f.dbPath);
  const rows = db.prepare("SELECT status FROM codex_relay_inbox ORDER BY rowid").all();
  db.close(); return rows.map((r) => r.status);
}

relayTest("relay forwards only the chosen source, labels provenance, and deduplicates", async (t) => {
  const f = fixture(t); const relay = await open(f);
  const wrong = { ...message(f), from: "uds:/wrong/source.sock" };
  await relay.receive(wrong, JSON.stringify(wrong));
  const body = 'hello\n```\n$(touch should-not-run)';
  const frame = message(f, "message-1", body);
  await relay.receive(frame, JSON.stringify(frame));
  await relay.receive(frame, JSON.stringify(frame));
  const calls = callRows(f);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["queue", "--thread", threadId, "--message"]);
  assert.match(calls[0][4], /Claude.*ChatGPT/);
  assert.match(calls[0][4], /not.*human instruction/i);
  assert.match(calls[0][4], /> \$\(touch should-not-run\)/);
  assert.deepEqual(statuses(f), ["queued"]);
  assert.equal(fs.existsSync(path.join(root, "should-not-run")), false);
  const db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM fetches").get().n, 3);
  db.close();
});

relayTest("controls and auth never become chat prompts; auth secrets are not persisted", async (t) => {
  const f = fixture(t); const relay = await open(f);
  const control = { type: "control", action: "peer_idle_notice", from: "uds:" + f.target.messagingSocketPath };
  await relay.receive(control, JSON.stringify(control));
  await relay.receive({ type: "auth", token: "do-not-store-test-token" }, '{"type":"auth","token":"do-not-store-test-token"}');
  assert.equal(callRows(f).length, 0);
  const db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM fetches").get().n, 1);
  db.close();
});

relayTest("restart skips queued messages and prevents two live owners", async (t) => {
  const f = fixture(t); const relay = await open(f);
  await relay.receive(message(f), JSON.stringify(message(f)));
  await assert.rejects(open(f), /already running/i);
  relay.close();
  const resumed = await open(f); await resumed.flush();
  await resumed.receive(message(f), JSON.stringify(message(f)));
  assert.equal(callRows(f).length, 1);
});

relayTest("known pre-spawn failure is retryable but ambiguous queue failure is not", async (t) => {
  const f = fixture(t); const relay = await open(f, { codexBin: path.join(f.dir, "missing-codex") });
  await relay.receive(message(f), JSON.stringify(message(f)));
  assert.deepEqual(statuses(f), ["failed"]); relay.close();
  const resumed = await open(f); await resumed.flush();
  assert.deepEqual(statuses(f), ["queued"]);
  fs.writeFileSync(path.join(f.dir, "fail"), "1");
  await resumed.receive(message(f, "message-2"), JSON.stringify(message(f, "message-2")));
  assert.deepEqual(statuses(f), ["queued", "uncertain"]); resumed.close();
  fs.unlinkSync(path.join(f.dir, "fail"));
  const again = await open(f); await again.flush();
  assert.equal(callRows(f).length, 2);
});

relayTest("oversized peer text is preserved and rejected without a partial chat message", async (t) => {
  const f = fixture(t); const relay = await open(f);
  const frame = message(f, "too-large", "a".repeat(40000));
  await relay.receive(frame, JSON.stringify(frame));
  assert.deepEqual(statuses(f), ["rejected"]);
  assert.equal(callRows(f).length, 0);
});

relayTest("raw frame and derived inbox entry commit atomically before dispatch", async (t) => {
  const f = fixture(t); const relay = await open(f);
  const db = new DatabaseSync(f.dbPath);
  db.exec("CREATE TRIGGER test_insert_failure BEFORE INSERT ON codex_relay_inbox BEGIN SELECT RAISE(ABORT,'simulated disk-write failure'); END");
  assert.throws(() => relay.receive(message(f), JSON.stringify(message(f))), /simulated disk-write failure/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM fetches").get().n, 0);
  assert.equal(callRows(f).length, 0);
  db.exec("DROP TRIGGER test_insert_failure"); db.close();
  await relay.receive(message(f), JSON.stringify(message(f)));
  assert.deepEqual(statuses(f), ["queued"]);
});

relayTest("a dispatch database failure does not permanently poison later messages", async (t) => {
  const f = fixture(t); const relay = await open(f);
  await relay.flush();
  fs.unlinkSync(f.dbPath + ".relay.log");
  fs.mkdirSync(f.dbPath + ".relay.log");
  const db = new DatabaseSync(f.dbPath);
  db.exec("CREATE TRIGGER test_dispatch_failure BEFORE UPDATE OF status ON codex_relay_inbox WHEN NEW.status='dispatching' BEGIN SELECT RAISE(ABORT,'dispatch failure'); END");
  await assert.rejects(relay.receive(message(f), JSON.stringify(message(f))), /dispatch failure/);
  db.exec("DROP TRIGGER test_dispatch_failure"); db.close();
  await relay.receive(message(f, "message-2"), JSON.stringify(message(f, "message-2")));
  assert.equal(callRows(f).length, 2);
  assert.deepEqual(statuses(f), ["queued", "queued"]);
});

relayTest("all peer line endings remain inside the quote and malformed blocks preserve raw data", async (t) => {
  const f = fixture(t); const relay = await open(f);
  const frame = message(f, "line-endings", [{ type: "text", text: "a\rb\r\n\u0085c\u2028d\u2029e" }]);
  await relay.receive(frame, JSON.stringify(frame));
  const quoted = callRows(f)[0][4].split("\n\n").at(-1);
  assert.ok(quoted.split("\n").every((line) => line.startsWith("> ")));
  assert.doesNotMatch(quoted, /[\r\u0085\u2028\u2029]/);
  const malformed = message(f, "malformed-blocks", [null, { type: "text", text: "still valid" }, { type: "text", text: 123 }]);
  await relay.receive(malformed, JSON.stringify(malformed));
  assert.equal(callRows(f).length, 2);
});

relayTest("secure listener rejects unauthenticated frames and accepts its token handshake", async (t) => {
  const f = fixture(t); const config = path.join(f.dir, "config");
  const received = path.join(f.dir, "received.txt");
  const program = `import fs from 'node:fs';import {startPeerAgentDaemon} from ${JSON.stringify(pathToFileURL(path.join(root, "src/index.mjs")).href)};const d=await startPeerAgentDaemon({requireAuth:true,sockDir:${JSON.stringify(path.join(f.dir, "s"))},onMessage:()=>fs.appendFileSync(${JSON.stringify(received)},'received\\n')});console.log(JSON.stringify({pid:d.pid,socketPath:d.socketPath}));`;
  f.child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdio: ["ignore", "pipe", "pipe"],
  });
  const info = await new Promise((resolve, reject) => {
    let buf = ""; const timer = setTimeout(() => reject(new Error("listener not ready")), 2000);
    f.child.stdout.on("data", (chunk) => { buf += chunk; if (buf.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(buf.split("\n")[0])); } });
  });
  const send = (lines) => new Promise((resolve) => {
    const conn = net.createConnection(info.socketPath);
    conn.on("error", resolve); conn.on("close", resolve);
    conn.on("connect", () => conn.end(lines.join("\n") + "\n"));
  });
  await send([JSON.stringify({ type: "user", message: { content: "unauthenticated" } })]);
  assert.equal(fs.existsSync(received), false);
  const key = path.join(config, "sessions", `${info.pid}.${crypto.createHash("sha256").update(path.resolve(info.socketPath)).digest("hex")}.key`);
  const token = JSON.parse(fs.readFileSync(key, "utf8")).peerToken;
  await send([JSON.stringify({ type: "auth", token }), JSON.stringify({ type: "user", message: { content: "authenticated" } })]);
  assert.equal(fs.readFileSync(received, "utf8"), "received\n");
});

relayTest("restart quarantines interrupted dispatch and raw NUL text is rejected", async (t) => {
  const f = fixture(t); const relay = await open(f);
  await relay.receive(message(f), JSON.stringify(message(f)));
  relay.close();
  const db = new DatabaseSync(f.dbPath);
  db.prepare("UPDATE codex_relay_inbox SET status='dispatching'").run();
  db.close();
  const resumed = await open(f); await resumed.flush();
  assert.deepEqual(statuses(f), ["uncertain"]);
  assert.equal(callRows(f).length, 1);
  await resumed.receive(message(f, "nul-text", "bad\0text"));
  assert.deepEqual(statuses(f), ["uncertain", "rejected"]);
  assert.equal(callRows(f).length, 1);
});


async function desktop(t, f, respond = () => ({ result: { turnId: "active-turn" } })) {
  const socketPath = path.join(f.dir, "desktop.sock"), requests = [], sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const n = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, 4 + n));
        buffer = buffer.subarray(4 + n); requests.push(request);
        const answer = request.method === "initialize" ? { clientId: "relay-client" }
          : request.method === "thread-owner-discovery" ? { supportsUntrustedAppInput: true }
          : respond(request, socket);
        if (answer === null) continue;
        const frame = { type: "response", requestId: request.requestId, method: request.method,
          resultType: typeof answer === "string" ? "error" : "success", handledByClientId: "owner-client",
          ...(typeof answer === "string" ? { error: answer } : { result: answer }) };
        const body = Buffer.from(JSON.stringify(frame)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return { socketPath, requests };
}

function inbox(f) {
  const db = new DatabaseSync(f.dbPath);
  try { return db.prepare("SELECT msg_id,status,route,turn_id,route_note FROM codex_relay_inbox ORDER BY rowid").all(); }
  finally { db.close(); }
}

relayTest("hybrid routes ordinary messages to Queue and explicit urgent messages to native Steer once", async (t) => {
  const f = fixture(t), app = await desktop(t, f);
  const relay = await open(f, { routing: "hybrid", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "ordinary", "Review complete"));
  await relay.receive(message(f, "urgent", '<cross-session-message>\n[STEER] Stop current work\n</cross-session-message>'));
  await relay.receive(message(f, "urgent", "[QUEUE] changed duplicate"));
  const rows = inbox(f);
  assert.deepEqual(rows.map((r) => [r.status, r.route, r.turn_id]), [["queued", "queue", null], ["steered", "steer", "active-turn"]]);
  assert.equal(callRows(f).length, 1);
  const calls = app.requests.filter((r) => r.method === "thread-follower-steer-turn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.conversationId, threadId);
  assert.match(calls[0].params.input[0].text, /not a new human instruction/);
  assert.match(calls[0].params.input[0].text, /> \[STEER\] Stop current work/);
  relay.close(); const resumed = await open(f, { routing: "queue", desktopSocketPath: app.socketPath });
  await resumed.flush(); assert.equal(callRows(f).length, 1);
});

relayTest("hybrid idle rejection falls back once to Queue with a durable reason", async (t) => {
  const f = fixture(t), app = await desktop(t, f, () => `Conversation ${threadId} is not being streamed.`);
  const relay = await open(f, { routing: "hybrid", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "idle", "[STEER] Direction correction"));
  const [row] = inbox(f);
  assert.equal(row.status, "queued"); assert.equal(row.route, "steer"); assert.equal(row.turn_id, null);
  assert.ok(row.route_note); assert.equal(callRows(f).length, 1);
});

relayTest("lost Steer response is uncertain and never also queued or replayed", async (t) => {
  const f = fixture(t), app = await desktop(t, f, (_request, socket) => { socket.destroy(); return null; });
  const relay = await open(f, { routing: "hybrid", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "lost", "[STEER] Stop work"));
  assert.deepEqual(statuses(f), ["uncertain"]); assert.equal(callRows(f).length, 0);
  relay.close(); const resumed = await open(f, { routing: "hybrid", desktopSocketPath: app.socketPath }); await resumed.flush();
  assert.equal(app.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
});

relayTest("hybrid without a desktop endpoint uses existing Queue; queue-only never connects", async (t) => {
  const f = fixture(t); const relay = await open(f, { routing: "hybrid", desktopSocketPath: path.join(f.dir, "absent.sock") });
  await relay.receive(message(f, "offline", "[STEER] Stop work"));
  assert.equal(inbox(f)[0].status, "queued"); assert.ok(inbox(f)[0].route_note);
  relay.close(); const plain = await open(f, { desktopSocketPath: path.join(f.dir, "absent.sock") });
  await plain.receive(message(f, "legacy", "[STEER] Stop work"));
  assert.equal(inbox(f)[1].route, "queue"); assert.equal(inbox(f)[1].route_note, null);
});

relayTest("migration keeps old pending rows Queue and remembers chosen routes across restart", async (t) => {
  const f = fixture(t), relay = await open(f, { codexBin: path.join(f.dir, "missing-codex") });
  await relay.receive(message(f, "legacy", "[STEER] old message")); relay.close();
  const db = new DatabaseSync(f.dbPath);
  db.exec("ALTER TABLE codex_relay_inbox DROP COLUMN route; ALTER TABLE codex_relay_inbox DROP COLUMN turn_id; ALTER TABLE codex_relay_inbox DROP COLUMN route_note;"); db.close();
  const migrated = await open(f, { routing: "hybrid", desktopSocketPath: path.join(f.dir, "absent.sock") });
  await migrated.flush(); assert.equal(inbox(f)[0].route, "queue"); assert.equal(inbox(f)[0].status, "queued");
  assert.equal(inbox(f)[0].route_note, null);
});

relayTest("invalid routing fails before opening DB; urgent markers cannot bypass source/type guards", async (t) => {
  const f = fixture(t); await assert.rejects(open(f, { routing: "invalid" }), /routing must be/);
  assert.equal(fs.existsSync(f.dbPath), false);
  const app = await desktop(t, f), relay = await open(f, { routing: "hybrid", desktopSocketPath: app.socketPath });
  await relay.receive({ ...message(f, "wrong", "[STEER] Stop"), from: "uds:/wrong/source.sock" });
  await relay.receive({ ...message(f, "control", "[STEER] Stop"), type: "control" });
  await relay.receive(message(f, "bad id", "[STEER] Stop"));
  assert.equal(app.requests.length, 0); assert.equal(inbox(f).length, 0); assert.equal(callRows(f).length, 0);
});


relayTest("immediate routes unmarked and QUEUE-marked messages directly, never invoking CLI Queue", async (t) => {
  const f = fixture(t), app = await desktop(t, f);
  const relay = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "normal-direct", "Review complete"));
  await relay.receive(message(f, "marked-direct", "[QUEUE] Owner wants direct delivery"));
  await relay.receive(message(f, "normal-direct", "changed duplicate"));
  assert.deepEqual(statuses(f), ["steered", "steered"]);
  assert.equal(callRows(f).length, 0);
  assert.equal(app.requests.filter(r => r.method === "thread-follower-steer-turn").length, 2);
});

relayTest("immediate unavailable native owner fails explicitly without UI Queue fallback", async (t) => {
  const f = fixture(t), relay = await open(f, { routing: "immediate", desktopSocketPath: path.join(f.dir, "absent.sock") });
  await relay.receive(message(f, "direct-offline", "Normal direct message"));
  assert.deepEqual(statuses(f), ["failed"]); assert.equal(callRows(f).length, 0);
});

relayTest("immediate idle rejection starts the existing thread once with the same stable input", async (t) => {
  const f = fixture(t), app = await desktop(t, f, (request) => request.method === "thread-follower-steer-turn"
    ? `Conversation ${threadId} is not being streamed.` : { result: { turn: { id: "idle-started-turn" } } });
  const relay = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "idle-direct", "Direct ordinary message"));
  const [row] = inbox(f); assert.equal(row.status, "started"); assert.equal(row.turn_id, "idle-started-turn");
  const steer = app.requests.find((r) => r.method === "thread-follower-steer-turn");
  const start = app.requests.find((r) => r.method === "thread-follower-start-turn");
  assert.ok(start); assert.equal(start.version, 3); assert.equal(start.targetClientId, "owner-client");
  assert.deepEqual(start.params, { conversationId: threadId, turnStart: {
    request: { threadId, input: steer.params.input, clientUserMessageId: steer.params.clientUserMessageId },
    context: { restoreMessage: steer.params.restoreMessage },
  } });
  assert.equal(callRows(f).length, 0);
  relay.close(); const resumed = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
  await resumed.flush(); await resumed.receive(message(f, "idle-direct", "changed duplicate"));
  assert.equal(app.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
  assert.equal(app.requests.filter((r) => r.method === "thread-follower-start-turn").length, 1);
  assert.equal(callRows(f).length, 0); assert.deepEqual(statuses(f), ["started"]);
});

relayTest("lost or unknown idle-start response is uncertain and never queued or started again", async (t) => {
  for (const failure of ["disconnect", "client-disconnected"]) {
    const f = fixture(t), app = await desktop(t, f, (request, socket) => {
      if (request.method === "thread-follower-steer-turn") return `Cannot steer conversation ${threadId} because its active turn already ended`;
      if (failure === "disconnect") { socket.destroy(); return null; }
      return failure;
    });
    const relay = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
    await relay.receive(message(f, "lost-start", "Ordinary message"));
    assert.deepEqual(statuses(f), ["uncertain"]); assert.equal(callRows(f).length, 0);
    relay.close(); const resumed = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
    await resumed.flush(); await resumed.receive(message(f, "lost-start", "duplicate"));
    assert.equal(app.requests.filter((r) => r.method === "thread-follower-start-turn").length, 1);
    assert.equal(app.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
    assert.equal(callRows(f).length, 0); assert.deepEqual(statuses(f), ["uncertain"]);
  }
});

relayTest("known native start handler rejection fails explicitly without CLI Queue", async (t) => {
  const f = fixture(t), app = await desktop(t, f, (request) => request.method === "thread-follower-steer-turn"
    ? `Conversation ${threadId} is not being streamed.` : "no-handler-for-request");
  const relay = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "rejected-start", "Ordinary message"));
  assert.deepEqual(statuses(f), ["failed"]); assert.equal(callRows(f).length, 0);
  assert.equal(app.requests.filter((r) => r.method === "thread-follower-start-turn").length, 1);
});

relayTest("ambiguous active immediate Steer never attempts an idle start or CLI Queue", async (t) => {
  const f = fixture(t), app = await desktop(t, f, (_request, socket) => { socket.destroy(); return null; });
  const relay = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
  await relay.receive(message(f, "lost-active", "Ordinary message"));
  relay.close(); const resumed = await open(f, { routing: "immediate", desktopSocketPath: app.socketPath });
  await resumed.flush(); await resumed.receive(message(f, "lost-active", "duplicate"));
  assert.deepEqual(statuses(f), ["uncertain"]); assert.equal(callRows(f).length, 0);
  assert.equal(app.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
  assert.equal(app.requests.filter((r) => r.method === "thread-follower-start-turn").length, 0);
});

relayTest("immediate does not require a CLI Queue executable on PATH", async (t) => {
  const f = fixture(t), app = await desktop(t, f), access = fs.accessSync;
  fs.accessSync = (candidate, ...args) => {
    if (path.basename(candidate) === "codex") throw Object.assign(new Error("No CLI installed"), { code: "ENOENT" });
    return access(candidate, ...args);
  };
  let relay;
  try { relay = await open(f, { routing: "immediate", codexBin: undefined, desktopSocketPath: app.socketPath }); }
  finally { fs.accessSync = access; }
  await relay.receive(message(f, "native-only", "Unmarked normal peer"));
  assert.deepEqual(statuses(f), ["steered"]); assert.equal(callRows(f).length, 0);
});
