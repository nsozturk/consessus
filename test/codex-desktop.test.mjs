import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileCodexQueueCard, startCodexDesktop, steerCodexDesktop } from "../src/codex-desktop.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const threadId = "11111111-2222-4333-8444-555555555555";
const messageId = "a".repeat(64);
const text = '[STEER] Yön: 🛑\n> peer data\n`$(literal)` "quoted"';
const clientId = "fixture-client", ownerId = "fixture-owner";
const encode = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
const reply = (socket, request, result, extra = {}) => socket.write(encode({ type: "response", requestId: request.requestId,
  method: request.method, resultType: "success", handledByClientId: request.method === "initialize" ? clientId : ownerId, result, ...extra }));
const reject = (socket, request, error) => socket.write(encode({ type: "response", requestId: request.requestId, resultType: "error", error }));

async function fixture(t, handler) {
  const parent = path.join(root, "tmp/agent-peer-desktop");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "r-"));
  const f = { dir, socketPath: path.join(dir, "s.sock"), frames: [], requests: [], connections: [] };
  const server = net.createServer((socket) => {
    f.connections.push(socket); socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE();
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4); f.frames.push(request);
        if (request.type !== "request") continue;
        f.requests.push(request);
        if (handler?.(request, socket, f)) continue;
        if (request.method === "initialize") reply(socket, request, { clientId });
        else if (request.method === "thread-owner-discovery") reply(socket, request, { supportsUntrustedAppInput: true });
        else reply(socket, request, { result: { turnId: "fixture-turn" } });
      }
    });
  });
  await new Promise((resolve, rejectListen) => { server.once("error", rejectListen); server.listen(f.socketPath, resolve); });
  t.after(async () => {
    for (const socket of f.connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
const steer = (f, extra = {}) => steerCodexDesktop({ threadId, text, messageId, socketPath: f.socketPath, ...extra });
const mutations = (f) => f.requests.filter((request) => request.method === "thread-follower-steer-turn");

test("fragmented frames initialize, discover and pin one native Steer without changing text", async (t) => {
  const f = await fixture(t, (request, socket) => {
    if (request.method !== "initialize") return false;
    socket.write(encode({ type: "broadcast", method: "ignored" }));
    socket.write(encode({ type: "client-discovery-request", requestId: "fixture-discovery", request: {} }));
    const bytes = encode({ type: "response", requestId: request.requestId, method: request.method,
      resultType: "success", handledByClientId: clientId, result: { clientId } });
    socket.write(bytes.subarray(0, 1));
    setImmediate(() => { socket.write(bytes.subarray(1, 3)); setImmediate(() => socket.write(bytes.subarray(3))); });
    return true;
  });
  assert.deepEqual(await steer(f), { status: "steered", turnId: "fixture-turn" });
  assert.equal(f.connections.length, 1);
  assert.equal(f.requests.length, 3);
  const [init, owner, request] = f.requests;
  assert.equal(init.sourceClientId, "initializing-client"); assert.equal(init.version, 0);
  assert.deepEqual(init.params, { clientType: "claude-peer" });
  assert.equal(owner.sourceClientId, clientId); assert.equal(owner.version, 1);
  assert.deepEqual(owner.params, { hostId: "local", conversationId: threadId });
  assert.equal(request.version, 2); assert.equal(request.hostId, "local");
  assert.equal(request.sourceClientId, clientId); assert.equal(request.targetClientId, ownerId);
  assert.equal(init.timeoutMs, 12000); assert.equal(owner.timeoutMs, 12000); assert.equal(request.timeoutMs, 45000);
  assert.deepEqual(request.params, { conversationId: threadId, input: [{ type: "text", text, text_elements: [] }],
    clientUserMessageId: messageId, restoreMessage: { id: messageId, text, context: { prompt: text, addedFiles: [],
      fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: [] } }, attachments: [], serviceTier: null });
  assert.deepEqual(f.frames.find((frame) => frame.type === "client-discovery-response"), {
    type: "client-discovery-response", requestId: "fixture-discovery", response: { canHandle: false },
  });
  assert.equal(new Set(f.requests.map((request) => request.requestId)).size, 3);
});

test("only exact native idle errors permit Queue after a Steer request", async (t) => {
  for (const error of [`Conversation ${threadId} is not being streamed.`, `Cannot steer conversation ${threadId} because its active turn already ended`]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-steer-turn") return false;
      reject(socket, request, error); return true;
    });
    assert.deepEqual(await steer(f), { status: "queue", reason: "no-active-turn" });
    assert.equal(mutations(f).length, 1);
  }
});

test("a validated acceptance remains accepted if the connection faults immediately afterwards", async (t) => {
  const f = await fixture(t, (request, socket) => {
    if (request.method !== "thread-follower-steer-turn") return false;
    const bytes = encode({ type: "response", requestId: request.requestId, method: request.method,
      resultType: "success", handledByClientId: ownerId, result: { result: { turnId: "accepted-turn" } } });
    socket.write(Buffer.concat([bytes, Buffer.alloc(4)]));
    socket.end(); return true;
  });
  assert.deepEqual(await steer(f), { status: "steered", turnId: "accepted-turn" });
  assert.equal(mutations(f).length, 1);
});

test("definite routing or handler rejection permits Queue without a second mutation", async (t) => {
  for (const error of ["no-client-found", "request-version-mismatch", "no-handler-for-request"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-steer-turn") return false;
      reject(socket, request, error); return true;
    });
    assert.deepEqual(await steer(f), { status: "queue", reason: error });
    assert.equal(mutations(f).length, 1); assert.equal(f.requests.length, 3);
  }
});

test("initialization and owner capability failures return Queue before mutation", async (t) => {
  for (const phase of ["initialize", "thread-owner-discovery", "missing-owner", "old-owner"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method === phase) { reject(socket, request, "fixture-rejected"); return true; }
      if (request.method !== "thread-owner-discovery") return false;
      if (phase === "missing-owner") reply(socket, request, { supportsUntrustedAppInput: true }, { handledByClientId: "" });
      else if (phase === "old-owner") reply(socket, request, { supportsUntrustedAppInput: false });
      else return false;
      return true;
    });
    assert.equal((await steer(f)).status, "queue"); assert.equal(mutations(f).length, 0);
  }
});

test("missing, regular and symlink endpoints are never connected", async (t) => {
  const f = await fixture(t);
  const regular = path.join(f.dir, "regular"); fs.writeFileSync(regular, "fixture");
  const link = path.join(f.dir, "link"); fs.symlinkSync(f.socketPath, link);
  const dirLink = path.join(f.dir, "directory-link"); fs.symlinkSync(f.dir, dirLink);
  for (const socketPath of [path.join(f.dir, "missing"), regular, link, path.join(dirLink, "s.sock")]) {
    assert.equal((await steer(f, { socketPath })).status, "queue");
  }
  assert.equal(f.connections.length, 0);
});

test("connection refusal before any write is a definite Queue result", async (t) => {
  const f = await fixture(t), original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () {
    queueMicrotask(() => this.emit("error", Object.assign(new Error("fixture refused"), { code: "ECONNREFUSED" })));
    return this;
  };
  try { assert.equal((await steer(f)).status, "queue"); }
  finally { net.Socket.prototype.connect = original; }
  assert.equal(f.connections.length, 0);
});

test("disconnect after the mutation is uncertain and never retried", async (t) => {
  const f = await fixture(t, (request, socket) => {
    if (request.method !== "thread-follower-steer-turn") return false;
    socket.destroy(); return true;
  });
  await assert.rejects(steer(f), /connection closed/); assert.equal(mutations(f).length, 1);
});

test("timeout after mutation is uncertain without a second request", async (t) => {
  const f = await fixture(t, (request) => request.method === "thread-follower-steer-turn");
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 45000 ? 25 : delay, ...args);
  try { await assert.rejects(steer(f), /timeout/); }
  finally { globalThis.setTimeout = original; }
  assert.equal(mutations(f).length, 1); assert.equal(f.requests.length, 3);
});

test("unknown errors and near-matching idle text remain uncertain", async (t) => {
  for (const error of ["client-disconnected", "timeout", `Conversation ${threadId} is not being streamed. extra`,
    "Conversation another-thread is not being streamed."]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-steer-turn") return false;
      reject(socket, request, error); return true;
    });
    await assert.rejects(steer(f), /after handoff/); assert.equal(mutations(f).length, 1);
  }
});

test("malformed JSON and oversized frames after mutation remain uncertain", async (t) => {
  for (const malformed of [true, false]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-steer-turn") return false;
      const header = Buffer.alloc(4); header.writeUInt32LE(malformed ? 3 : 1024 * 1024 + 1);
      socket.write(malformed ? Buffer.concat([header, Buffer.from("BAD")]) : header); return true;
    });
    await assert.rejects(steer(f)); assert.equal(mutations(f).length, 1);
  }
});

test("malformed acceptance, wrong owner or response method is uncertain", async (t) => {
  for (const variant of ["missing-turn", "wrong-owner", "wrong-method", "wrong-result-type"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-steer-turn") return false;
      reply(socket, request, variant === "missing-turn" ? {} : { result: { turnId: "fixture-turn" } }, {
        ...(variant === "wrong-owner" ? { handledByClientId: "another-owner" } : {}),
        ...(variant === "wrong-method" ? { method: "different-method" } : {}),
        ...(variant === "wrong-result-type" ? { resultType: "unknown" } : {}),
      }); return true;
    });
    await assert.rejects(steer(f), /Malformed/); assert.equal(mutations(f).length, 1);
  }
});

test("oversized outbound request queues before the mutation write", async (t) => {
  const f = await fixture(t);
  assert.equal((await steer(f, { text: "x".repeat(1024 * 1024) })).status, "queue");
  assert.equal(mutations(f).length, 0); assert.equal(f.requests.length, 2);
});

test("invalid caller values fail without connecting", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ threadId: "" }, { messageId: null }, { text: [] }]) await assert.rejects(steer(f, extra), TypeError);
  assert.equal(f.connections.length, 0);
});

const queueId = "fixture-consumed-queue-id";
const reconcile = (f, extra = {}) => reconcileCodexQueueCard({ threadId, queueId, socketPath: f.socketPath, ...extra });
const removals = (f) => f.requests.filter((request) => request.method === "thread-follower-remove-queued-message");

test("queue-card reconciliation pins the exact native removal method, owner and queue ID", async (t) => {
  const f = await fixture(t, (request, socket) => {
    if (request.method !== "thread-follower-remove-queued-message") return false;
    reply(socket, request, { removed: null }); return true;
  });
  assert.deepEqual(await reconcile(f), { status: "reconciled" });
  assert.equal(f.connections.length, 1); assert.equal(f.requests.length, 3);
  const [initialize, discovery, removal] = f.requests;
  assert.equal(initialize.method, "initialize"); assert.equal(initialize.version, 0);
  assert.deepEqual(discovery.params, { hostId: "local", conversationId: threadId });
  assert.equal(discovery.method, "thread-owner-discovery"); assert.equal(discovery.version, 1);
  assert.equal(removal.version, 2); assert.equal(removal.hostId, "local");
  assert.equal(removal.sourceClientId, clientId); assert.equal(removal.targetClientId, ownerId);
  assert.deepEqual(removal.params, { conversationId: threadId, messageId: queueId });
  assert.equal(mutations(f).length, 0);
});

test("queue-card cleanup validates owner and acceptance even when removed is null", async (t) => {
  for (const variant of ["missing-removed", "removed-boolean", "removed-string", "removed-array", "wrong-owner", "missing-owner", "wrong-method", "missing-method", "wrong-result-type"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-remove-queued-message") return false;
      const extra = { ...(variant === "wrong-owner" ? { handledByClientId: "different-owner" } : {}),
        ...(variant === "missing-owner" ? { handledByClientId: undefined } : {}),
        ...(variant === "wrong-method" ? { method: "thread-follower-steer-turn" } : {}),
        ...(variant === "missing-method" ? { method: undefined } : {}),
        ...(variant === "wrong-result-type" ? { resultType: "unknown" } : {}) };
      const removed = variant === "removed-boolean" ? false : variant === "removed-string" ? "done" : variant === "removed-array" ? [] : null;
      reply(socket, request, variant === "missing-removed" ? {} : { removed }, extra); return true;
    });
    await assert.rejects(reconcile(f), /Malformed/);
    assert.equal(removals(f).length, 1); assert.equal(mutations(f).length, 0);
  }
});

test("known queue-card routing rejections are unavailable without any Steer fallback", async (t) => {
  for (const error of ["no-client-found", "request-version-mismatch", "no-handler-for-request"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-remove-queued-message") return false;
      reject(socket, request, error); return true;
    });
    assert.equal((await reconcile(f)).status, "unavailable");
    assert.equal(removals(f).length, 1); assert.equal(mutations(f).length, 0);
  }
});

test("queue-card preflight failures never attempt native removal", async (t) => {
  const f = await fixture(t);
  const regular = path.join(f.dir, "cleanup-regular"); fs.writeFileSync(regular, "fixture");
  const link = path.join(f.dir, "cleanup-link"); fs.symlinkSync(f.socketPath, link);
  const directoryLink = path.join(f.dir, "cleanup-directory-link"); fs.symlinkSync(f.dir, directoryLink);
  for (const socketPath of [path.join(f.dir, "missing"), regular, link, path.join(directoryLink, "s.sock")]) {
    assert.equal((await reconcile(f, { socketPath })).status, "unavailable");
  }
  assert.equal(f.connections.length, 0);
  for (const phase of ["initialize", "thread-owner-discovery", "missing-owner", "old-owner"]) {
    const rejected = await fixture(t, (request, socket) => {
      if (request.method === phase) { reject(socket, request, "fixture-rejected"); return true; }
      if (request.method !== "thread-owner-discovery") return false;
      if (phase === "missing-owner") reply(socket, request, { supportsUntrustedAppInput: true }, { handledByClientId: "" });
      else if (phase === "old-owner") reply(socket, request, { supportsUntrustedAppInput: false });
      else return false;
      return true;
    });
    assert.equal((await reconcile(rejected)).status, "unavailable");
    assert.equal(removals(rejected).length, 0); assert.equal(mutations(rejected).length, 0);
  }
});

test("unknown errors and disconnects after native queue-card removal stay ambiguous", async (t) => {
  for (const failure of ["client-disconnected", "timeout", "disconnect"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-remove-queued-message") return false;
      if (failure === "disconnect") socket.destroy(); else reject(socket, request, failure);
      return true;
    });
    await assert.rejects(reconcile(f));
    assert.equal(removals(f).length, 1); assert.equal(mutations(f).length, 0);
  }
});

test("invalid cleanup IDs fail before native connection", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ threadId: "" }, { queueId: null }, { queueId: " " }]) await assert.rejects(reconcile(f, extra), TypeError);
  assert.equal(f.connections.length, 0);
});

const start = (f) => startCodexDesktop({ threadId, text, messageId, socketPath: f.socketPath });
const starts = (f) => f.requests.filter((request) => request.method === "thread-follower-start-turn");

test("native start pins the existing thread, stable message ID and exact input without config overrides", async (t) => {
  const f = await fixture(t, (request, socket) => {
    if (request.method !== "thread-follower-start-turn") return false;
    reply(socket, request, { result: { turn: { id: "started-turn" } } }); return true;
  });
  assert.deepEqual(await start(f), { status: "started", turnId: "started-turn" });
  assert.equal(f.requests.length, 3); assert.equal(starts(f).length, 1); assert.equal(mutations(f).length, 0);
  const [request] = starts(f);
  assert.equal(request.version, 3); assert.equal(request.hostId, "local");
  assert.equal(request.sourceClientId, clientId); assert.equal(request.targetClientId, ownerId);
  assert.deepEqual(request.params, { conversationId: threadId, turnStart: {
    request: { threadId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: messageId },
    context: { restoreMessage: { id: messageId, text, context: { prompt: text, addedFiles: [], fileAttachments: [],
      ideContext: null, imageAttachments: [], workspaceRoots: [] } } },
  } });
});

test("native start rejects malformed turn IDs, wrong owner and unknown acceptance", async (t) => {
  for (const variant of ["missing-turn", "empty-id", "numeric-id", "wrong-owner", "wrong-method"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-start-turn") return false;
      reply(socket, request, variant === "missing-turn" ? {} : { result: { turn: { id: variant === "empty-id" ? " " : variant === "numeric-id" ? 1 : "started-turn" } } }, {
        ...(variant === "wrong-owner" ? { handledByClientId: "other-owner" } : {}),
        ...(variant === "wrong-method" ? { method: "thread-follower-steer-turn" } : {}),
      }); return true;
    });
    await assert.rejects(start(f), /Malformed/); assert.equal(starts(f).length, 1); assert.equal(mutations(f).length, 0);
  }
});

test("known start rejection is unavailable and lost start acceptance remains uncertain", async (t) => {
  for (const failure of ["no-handler-for-request", "client-disconnected", "disconnect"]) {
    const f = await fixture(t, (request, socket) => {
      if (request.method !== "thread-follower-start-turn") return false;
      if (failure === "disconnect") socket.destroy(); else reject(socket, request, failure);
      return true;
    });
    if (failure === "no-handler-for-request") assert.equal((await start(f)).status, "unavailable");
    else await assert.rejects(start(f));
    assert.equal(starts(f).length, 1); assert.equal(mutations(f).length, 0);
  }
});
