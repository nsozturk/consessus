import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readOpencodeReply } from "../src/opencode-replies.mjs";
import { openOpencodeDelivery } from "../src/opencode-delivery.mjs";
import { defaultTransports, sendToSession } from "../src/send-router.mjs";

const AUTH = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
const headers = { authorization: AUTH };
const say = (id, text, extra = []) => ({ id, type: "assistant", content: [...extra, { type: "text", text }], time: { created: 1 } });
const idle = (id, outcome = "succeeded") => ({ id, type: "idle", outcome, time: { created: 1 } });
const note = id => ({ id, type: "synthetic", text: "Peer data", time: { created: 1 } });
const tool = { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "tool output" }] }, time: { created: 1 } };
// What the session held before the send: an earlier turn with its own answer and its own idle marker.
const earlier = [note("msg_0001"), say("msg_0002", "old answer"), idle("msg_0003")];

// A 2.x-shaped service. `histories` are oldest-first; each poll of the message list takes the next one.
function fakeService({ histories = [earlier], status = 200, active = {}, activeStatus = 200, hang = false, postId = "msg_0004", kind = "synthetic" } = {}) {
  const calls = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body });
      if (req.headers.authorization !== AUTH) { res.writeHead(401).end(); return; }
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/api/session/ses_one/message") {
        if (hang) return;
        if (url.searchParams.get("order") !== "desc" || url.searchParams.get("limit") !== "200") { res.writeHead(400).end("{}"); return; }
        const history = histories[Math.min(polls++, histories.length - 1)];
        res.writeHead(status).end(JSON.stringify({ data: [...history].reverse(), cursor: {} }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/session/active") { res.writeHead(activeStatus).end(JSON.stringify({ data: active })); return; }
      if (req.method === "GET" && url.pathname === "/openapi.json" && kind !== "desktop") {
        res.end(JSON.stringify({ paths: { "/api/session/{sessionID}/prompt": { post: {} }, "/api/session/{sessionID}/synthetic": { post: {} } } })); return;
      }
      if (req.method === "GET" && url.pathname === "/doc" && kind === "desktop") {
        res.end(JSON.stringify({ paths: { "/session/{sessionID}/prompt_async": { post: {} } } })); return;
      }
      if (req.method === "POST" && url.pathname === "/api/session/ses_one/synthetic") {
        res.end(JSON.stringify({ data: { id: postId, sessionID: "ses_one", type: "synthetic", delivery: "steer" } })); return;
      }
      if (req.method === "POST" && url.pathname === "/session/ses_one/prompt_async") { res.writeHead(204).end(); return; }
      res.writeHead(404).end("{}");
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({
    calls, polls: () => polls, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }),
  })));
}
const base = fake => ({ server: fake.url, headers, session: "ses_one", after: "msg_0004", pollMs: 5, timeoutMs: 2000 });
const frame = { type: "user", from_name: "Fake Peer", message: { content: "hello" } };
const env = { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "pw" };

test("returns the final assistant text of the turn that followed the marker, read-only", async () => {
  const done = [...earlier, note("msg_0004"), say("msg_0005", "interim", [tool]), say("msg_0006", "final answer", [{ type: "reasoning", text: "private thoughts" }]), idle("msg_0007")];
  const fake = await fakeService({ histories: [[...earlier, note("msg_0004")], done.slice(0, 5), done] });
  try {
    assert.deepEqual(await readOpencodeReply(base(fake)), { status: "replied", text: "final answer" });
    assert.equal(fake.polls(), 3);
    assert.ok(fake.calls.every(call => call.method === "GET" && call.url === "/api/session/ses_one/message?order=desc&limit=200"));
  } finally { await fake.close(); }
});

test("never returns assistant text or an idle marker from before the send", { timeout: 15000 }, async () => {
  // Marker present, nothing after it; and marker not in the page at all. Neither may fall back to the old answer.
  for (const history of [[...earlier, note("msg_0004")], earlier]) {
    const fake = await fakeService({ histories: [history] });
    try { assert.deepEqual(await readOpencodeReply({ ...base(fake), timeoutMs: 60 }), { status: "timeout" }); }
    finally { await fake.close(); }
  }
  // A later turn's answer is not this send's answer either: reading stops at the first idle marker.
  const fake = await fakeService({ histories: [[...earlier, note("msg_0004"), say("msg_0005", "mine"), idle("msg_0006"),
    note("msg_0007"), say("msg_0008", "someone else's turn"), idle("msg_0009")]] });
  try { assert.deepEqual(await readOpencodeReply(base(fake)), { status: "replied", text: "mine" }); }
  finally { await fake.close(); }
});

test("an unfinished turn is not an answer, and a finished turn without text is no-reply", { timeout: 15000 }, async () => {
  const running = await fakeService({ histories: [[...earlier, note("msg_0004"), say("msg_0005", "still thinking")]] });
  try { assert.deepEqual(await readOpencodeReply({ ...base(running), timeoutMs: 60 }), { status: "timeout" }); }
  finally { await running.close(); }
  const silent = await fakeService({ histories: [[...earlier, note("msg_0004"), { id: "msg_0005", type: "assistant", content: [tool], time: { created: 1 } }, idle("msg_0006")]] });
  try { assert.deepEqual(await readOpencodeReply(base(silent)), { status: "no-reply" }); }
  finally { await silent.close(); }
  const failed = await fakeService({ histories: [[...earlier, note("msg_0004"), idle("msg_0005", "failed")]] });
  try { assert.deepEqual(await readOpencodeReply(base(failed)), { status: "no-reply", outcome: "failed" }); }
  finally { await failed.close(); }
});

test("a server that refuses, answers nonsense or is gone is unavailable, not a reply", async () => {
  const refused = await fakeService({ status: 500 });
  try { assert.deepEqual(await readOpencodeReply(base(refused)), { status: "unavailable", reason: "HTTP 500" }); }
  finally { await refused.close(); }
  const locked = await fakeService();
  try { assert.deepEqual(await readOpencodeReply({ ...base(locked), headers: {} }), { status: "unavailable", reason: "HTTP 401" }); }
  finally { await locked.close(); }
  const gone = await fakeService();
  await gone.close();
  assert.deepEqual(await readOpencodeReply(base(gone)), { status: "unavailable", reason: "unreachable" });
  const odd = async () => ({ ok: true, json: async () => ({ data: "nope" }) });
  assert.deepEqual(await readOpencodeReply({ ...base(gone), request: odd }), { status: "unavailable", reason: "unexpected message list" });
});

test("gives up at the timeout, also when the server stops answering", { timeout: 15000 }, async () => {
  const fake = await fakeService({ histories: [[...earlier, note("msg_0004")]] });
  try {
    const started = performance.now();
    assert.deepEqual(await readOpencodeReply({ ...base(fake), timeoutMs: 80 }), { status: "timeout" });
    assert.ok(performance.now() - started < 3000);
    assert.ok(fake.polls() > 1);
  } finally { await fake.close(); }
  // The deadline is the reader's own: it holds even when the transport ignores the abort signal.
  const deaf = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.deepEqual(await readOpencodeReply({ ...base(fake), timeoutMs: 40, request: deaf }), { status: "timeout" });
  const hung = await fakeService({ hang: true });
  try {
    const started = performance.now();
    assert.deepEqual(await readOpencodeReply({ ...base(hung), timeoutMs: 80 }), { status: "timeout" });
    assert.ok(performance.now() - started < 2500);
  } finally { await hung.close(); }
});

test("bounds a huge answer on a UTF-8 boundary and rejects bad arguments", async () => {
  const fake = await fakeService({ histories: [[note("msg_0004"), say("msg_0005", "é".repeat(40000)), idle("msg_0006")]] });
  try {
    const reply = await readOpencodeReply(base(fake));
    assert.equal(reply.status, "replied");
    assert.equal(reply.truncated, true);
    assert.equal(Buffer.byteLength(reply.text), 65536);
    assert.ok(!reply.text.includes("�"));
    await assert.rejects(readOpencodeReply({ ...base(fake), session: "../ses_one" }), /session id/);
    await assert.rejects(readOpencodeReply({ ...base(fake), after: "" }), /marker/);
    await assert.rejects(readOpencodeReply({ ...base(fake), after: "msg_1/../x" }), /marker/);
    await assert.rejects(readOpencodeReply({ ...base(fake), server: "http://example.com" }), /loopback/);
    await assert.rejects(readOpencodeReply({ ...base(fake), pollMs: 0 }), /positive/);
    assert.equal(fake.polls(), 1);
  } finally { await fake.close(); }
});

test("deliver returns the admitted message id as the marker, and the handle reads the reply after it", async () => {
  const fake = await fakeService({ histories: [[...earlier, note("msg_0004"), say("msg_0005", "pong"), idle("msg_0006")]] });
  try {
    const delivery = await openOpencodeDelivery({ server: fake.url, session: "ses_one", cwd: process.cwd(), env });
    assert.deepEqual(await delivery.deliver(frame), { status: "delivered", session: "ses_one", busy: false, after: "msg_0004" });
    const order = fake.calls.map(call => `${call.method} ${call.url}`);
    assert.ok(order.indexOf("GET /api/session/active") < order.indexOf("POST /api/session/ses_one/synthetic"));
    assert.deepEqual(await delivery.readReply({ after: "msg_0004", pollMs: 5, timeoutMs: 2000 }), { status: "replied", text: "pong" });
    assert.ok(!JSON.stringify(Object.entries(delivery)).includes("pw"));
  } finally { await fake.close(); }
});

test("no marker when the session's state is unknown, the id is not a message id, or the server is the desktop one", async () => {
  const cases = [{ activeStatus: 500 }, { postId: "inb_1" }, { kind: "desktop" }];
  for (const options of cases) {
    const fake = await fakeService(options);
    try {
      const delivery = await openOpencodeDelivery({ server: fake.url, session: "ses_one", cwd: process.cwd(), env });
      assert.deepEqual(await delivery.deliver(frame), { status: "delivered", session: "ses_one" });
    } finally { await fake.close(); }
  }
});

test("the router reads an idle OpenCode session's reply and never a busy one's", async () => {
  const rows = [{ app: "opencode", id: "ses_one", path: process.cwd(), status: "idle", mode: "allow", asks: "never" }];
  const list = async () => ({ sessions: rows, unavailable: [] });
  const through = async fake => {
    const transports = defaultTransports({ openOpencode: options => openOpencodeDelivery({ ...options, server: fake.url, env }) });
    return sendToSession({ to: "ses_one", message: "ping", read: true, timeoutMs: 2000, list, transports });
  };
  const quiet = await fakeService({ histories: [[...earlier, note("msg_0004"), say("msg_0005", "pong"), idle("msg_0006")]] });
  try {
    const result = await through(quiet);
    assert.deepEqual(result.reply, { status: "replied", text: "pong" });
    assert.equal(result.after, "msg_0004");
  } finally { await quiet.close(); }
  const busy = await fakeService({ active: { ses_one: { type: "running" } },
    histories: [[...earlier, note("msg_0004"), say("msg_0005", "the earlier turn's words"), idle("msg_0006")]] });
  try {
    const result = await through(busy);
    assert.equal(result.status, "delivered");
    assert.equal(result.busy, true);
    assert.match(result.reply.reason, /busy when the message arrived/);
    assert.equal(busy.polls(), 0);
  } finally { await busy.close(); }
  const desktop = await fakeService({ kind: "desktop" });
  try { assert.match((await through(desktop)).reply.reason, /not supported for opencode sessions yet/); }
  finally { await desktop.close(); }
});
