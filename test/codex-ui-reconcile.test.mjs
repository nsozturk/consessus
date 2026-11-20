import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sqlite = await import("node:sqlite").catch(() => null);
const { DatabaseSync } = sqlite || {};
const relayTest = (name, fn) => test(name, { skip: !sqlite && "Optional relay requires node:sqlite (Node 22.13+ or 24+)" }, fn);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const threadId = "11111111-2222-4333-8444-555555555555";
const otherThread = "66666666-7777-4888-8999-000000000000";
const encode = (value) => {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

async function fixture(t, { native = "success", queueDatabase = true, reportQueueId = true } = {}) {
  const parent = path.join(root, "tmp/agent-ui-reconcile-tests"); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "r-"));
  const f = { dir, dbPath: path.join(dir, "relay.sqlite"), queueDbPath: path.join(dir, "queue_1.sqlite"),
    calls: path.join(dir, "calls.jsonl"), codexBin: path.join(dir, "codex"), socketPath: path.join(dir, "native.sock"),
    target: { sessionId: "fixture-source", messagingSocketPath: path.join(dir, "source.sock") },
    native, requests: [], relays: [], sockets: new Set() };
  if (queueDatabase) {
    const db = new DatabaseSync(f.queueDbPath);
    db.exec("CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message TEXT)"); db.close();
  }
  fs.writeFileSync(f.codexBin, `#!${process.execPath}\nimport fs from 'node:fs';\nimport { DatabaseSync } from 'node:sqlite';\nconst args=process.argv.slice(2), calls=${JSON.stringify(f.calls)};\nconst n=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\\n').length:0;\nfs.appendFileSync(calls,JSON.stringify(args)+'\\n');\nconst id='fixture-peer-'+(n+1);\n${queueDatabase ? `const db=new DatabaseSync(${JSON.stringify(f.queueDbPath)});db.prepare('INSERT INTO queued_items(id,thread_id,message) VALUES(?,?,?)').run(id,args[2],args[4]);db.close();` : ""}\nconsole.log(${reportQueueId ? "'Queued message '+id" : "'Queued message accepted'"});\n`, { mode: 0o700 });
  const server = net.createServer((socket) => {
    f.sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => f.sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const length = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (request.type !== "request") continue;
        f.requests.push(request);
        let result = { removed: null }, error;
        if (request.method === "initialize") result = { clientId: "fixture-relay-client" };
        else if (request.method === "thread-owner-discovery") result = { supportsUntrustedAppInput: true };
        else if (request.method === "thread-follower-steer-turn") result = { result: { turnId: "fixture-active-turn" } };
        else if (f.native === "disconnect") { socket.destroy(); continue; }
        else if (f.native === "unknown") error = "client-disconnected";
        else if (f.native === "unavailable") error = "no-handler-for-request";
        else if (f.native === "malformed") result = {};
        const send = () => socket.write(encode({ type: "response", requestId: request.requestId, method: request.method,
          resultType: error ? "error" : "success", handledByClientId: "fixture-owner", ...(error ? { error } : { result }) }));
        if (f.native === "delay" && request.method === "thread-follower-remove-queued-message") f.releaseReply = send;
        else send();
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(f.socketPath, resolve); });
  t.after(async () => {
    for (const relay of f.relays) relay.close();
    for (const socket of f.sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}

async function open(f, extra = {}) {
  const { openCodexRelay } = await import(pathToFileURL(path.join(root, "src/codex-relay.mjs")));
  const relay = openCodexRelay({ threadId, target: f.target, dbPath: f.dbPath, codexBin: f.codexBin,
    routing: "hybrid", desktopSocketPath: f.socketPath, queueDbPath: f.queueDbPath, log: () => {}, ...extra });
  f.relays.push(relay); return relay;
}
const frame = (f, id = "peer-1", content = "Review complete") => ({ type: "user", msg_id: id,
  from: "uds:" + f.target.messagingSocketPath, message: { role: "user", content } });
const calls = (f) => fs.existsSync(f.calls) ? fs.readFileSync(f.calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const removals = (f) => f.requests.filter((r) => r.method === "thread-follower-remove-queued-message");
function readInbox(f) {
  const db = new DatabaseSync(f.dbPath);
  try { return db.prepare("SELECT * FROM codex_relay_inbox ORDER BY rowid").all(); } finally { db.close(); }
}
function queueRows(f) {
  const db = new DatabaseSync(f.queueDbPath, { readOnly: true });
  try { return db.prepare("SELECT * FROM queued_items ORDER BY id").all(); } finally { db.close(); }
}
function queueSql(f, statement, ...args) {
  const db = new DatabaseSync(f.queueDbPath);
  try { return db.prepare(statement).run(...args); } finally { db.close(); }
}

relayTest("reconciliation protects pending rows and removes only an exact consumed peer card once", async (t) => {
  const f = await fixture(t), relay = await open(f);
  queueSql(f, "INSERT INTO queued_items VALUES(?,?,?)", "user-owned-queue", threadId, "Human queued text");
  await relay.receive(frame(f));
  assert.equal(typeof relay.reconcileUi, "function");
  assert.equal(readInbox(f)[0].status, "queued"); assert.equal(readInbox(f)[0].ui_status, "pending");
  await relay.reconcileUi();
  assert.equal(removals(f).length, 0); assert.equal(queueRows(f).length, 2);
  queueSql(f, "DELETE FROM queued_items WHERE id=? AND thread_id=?", "fixture-peer-1", threadId);
  await relay.reconcileUi(); await relay.reconcileUi();
  assert.equal(removals(f).length, 1);
  assert.deepEqual(removals(f)[0].params, { conversationId: threadId, messageId: "fixture-peer-1" });
  assert.deepEqual(queueRows(f).map((r) => r.id), ["user-owned-queue"]);
  assert.equal(readInbox(f)[0].status, "queued"); assert.equal(readInbox(f)[0].ui_status, "done");
  relay.close(); const resumed = await open(f); await resumed.flush(); await resumed.reconcileUi(); await resumed.receive(frame(f));
  assert.equal(calls(f).length, 1); assert.equal(removals(f).length, 1);
  assert.equal(f.requests.some((r) => r.method === "thread-follower-steer-turn"), false);
});

relayTest("queue presence is scoped to both queue ID and thread, without altering another thread", async (t) => {
  const f = await fixture(t), relay = await open(f); await relay.receive(frame(f));
  queueSql(f, "UPDATE queued_items SET thread_id=? WHERE id=?", otherThread, "fixture-peer-1");
  await relay.reconcileUi();
  assert.equal(removals(f).length, 1); assert.equal(readInbox(f)[0].ui_status, "done");
  assert.equal(queueRows(f)[0].thread_id, otherThread); assert.equal(calls(f).length, 1);
});

relayTest("preexisting queued rows migrate as legacy and never trigger native cleanup", async (t) => {
  const f = await fixture(t); let relay = await open(f, { routing: "queue" }); await relay.receive(frame(f)); relay.close();
  const db = new DatabaseSync(f.dbPath); db.exec("ALTER TABLE codex_relay_inbox DROP COLUMN ui_status"); db.close();
  queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
  relay = await open(f); await relay.flush(); await relay.reconcileUi();
  const [row] = readInbox(f); assert.equal(row.status, "queued"); assert.equal(row.ui_status, "legacy");
  assert.equal(removals(f).length, 0); assert.equal(calls(f).length, 1);
});

relayTest("default queue routing remains legacy even when its queue row has disappeared", async (t) => {
  const f = await fixture(t), relay = await open(f, { routing: undefined }); await relay.receive(frame(f));
  queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
  await relay.reconcileUi();
  assert.equal(readInbox(f)[0].ui_status, "legacy"); assert.equal(f.requests.length, 0); assert.equal(calls(f).length, 1);
});

relayTest("missing or unreadable queue databases safely preserve pending UI state", async (t) => {
  for (const database of ["missing", "invalid-schema", "invalid-file"]) {
    const f = await fixture(t), relay = await open(f); await relay.receive(frame(f));
    if (database === "missing") fs.unlinkSync(f.queueDbPath);
    else if (database === "invalid-schema") queueSql(f, "DROP TABLE queued_items");
    else fs.writeFileSync(f.queueDbPath, "not sqlite");
    await relay.reconcileUi(); await relay.reconcileUi();
    assert.equal(readInbox(f)[0].status, "queued"); assert.equal(readInbox(f)[0].ui_status, "pending");
    assert.equal(removals(f).length, 0); assert.equal(calls(f).length, 1);
    if (database === "missing") assert.equal(fs.existsSync(f.queueDbPath), false, "read-only reconciliation must not create a missing queue DB");
  }
});

relayTest("known native cleanup rejection remains retryable but never resends the peer text", async (t) => {
  const f = await fixture(t, { native: "unavailable" }), relay = await open(f); await relay.receive(frame(f));
  queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
  await relay.reconcileUi(); assert.equal(readInbox(f)[0].ui_status, "pending");
  assert.equal(calls(f).length, 1); assert.equal(removals(f).length, 1);
  f.native = "success"; await relay.reconcileUi();
  assert.equal(readInbox(f)[0].ui_status, "done"); assert.equal(calls(f).length, 1);
});

relayTest("ambiguous native cleanup is quarantined across repeated reconcile, receive and restart", async (t) => {
  for (const native of ["unknown", "disconnect", "malformed"]) {
    const f = await fixture(t, { native }), relay = await open(f); await relay.receive(frame(f));
    queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
    await relay.reconcileUi(); await relay.reconcileUi(); await relay.receive(frame(f));
    assert.equal(readInbox(f)[0].status, "queued"); assert.equal(readInbox(f)[0].ui_status, "uncertain");
    relay.close(); f.native = "success"; const resumed = await open(f); await resumed.flush(); await resumed.reconcileUi();
    assert.equal(removals(f).length, 1); assert.equal(calls(f).length, 1);
    assert.equal(readInbox(f)[0].status, "queued"); assert.equal(readInbox(f)[0].ui_status, "uncertain");
  }
});

relayTest("cleanup ignores other bindings and non-queued delivery states", async (t) => {
  const f = await fixture(t), relay = await open(f); await relay.receive(frame(f));
  queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
  const db = new DatabaseSync(f.dbPath);
  const [row] = db.prepare("SELECT * FROM codex_relay_inbox").all();
  db.prepare("UPDATE codex_relay_inbox SET binding=? WHERE id=?").run("unrelated-binding", row.id);
  await relay.reconcileUi(); assert.equal(removals(f).length, 0);
  db.prepare("UPDATE codex_relay_inbox SET binding=?,status='steered' WHERE id=?").run(row.binding, row.id);
  await relay.reconcileUi(); assert.equal(removals(f).length, 0);
  db.prepare("UPDATE codex_relay_inbox SET status='uncertain' WHERE id=?").run(row.id);
  await relay.reconcileUi(); assert.equal(removals(f).length, 0);
  db.close(); assert.equal(calls(f).length, 1);
});

relayTest("unavailable cleanup stops after three attempts without resending delivery", async (t) => {
  const f = await fixture(t, { native: "unavailable" }), relay = await open(f);
  await relay.receive(frame(f)); queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
  for (let i = 0; i < 5; i++) await relay.reconcileUi();
  assert.equal(removals(f).length, 3);
  assert.equal(readInbox(f)[0].ui_status, "skipped");
  assert.equal(readInbox(f)[0].status, "queued");
  assert.equal(calls(f).length, 1);
});

relayTest("queue store failure disables cleanup until restart while delivery stays available", async (t) => {
  const f = await fixture(t, { queueDatabase: false }), relay = await open(f);
  await relay.receive(frame(f)); await relay.reconcileUi();
  const db = new DatabaseSync(f.queueDbPath);
  db.exec("CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message TEXT)"); db.close();
  await relay.reconcileUi();
  assert.equal(removals(f).length, 0); assert.equal(readInbox(f)[0].ui_status, "pending");
  await relay.receive(frame(f, "peer-2")); assert.equal(calls(f).length, 2);
  relay.close(); const resumed = await open(f); await resumed.reconcileUi();
  assert.equal(removals(f).length, 1); assert.equal(readInbox(f)[0].ui_status, "done");
});

relayTest("slow native cleanup does not block the next peer delivery", async (t) => {
  const f = await fixture(t, { native: "delay" }), relay = await open(f);
  await relay.receive(frame(f)); queueSql(f, "DELETE FROM queued_items WHERE id=?", "fixture-peer-1");
  const cleanup = relay.reconcileUi();
  for (let i = 0; !f.releaseReply && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof f.releaseReply, "function", "cleanup reached its native await");
  let timer;
  try {
    await Promise.race([relay.receive(frame(f, "peer-2")), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("cleanup blocked delivery")), 1500); })]);
    assert.equal(calls(f).length, 2);
  } finally { clearTimeout(timer); f.releaseReply(); await cleanup; }
});
