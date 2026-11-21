import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insideClaudeSession, sendToClaude, NEEDS_MODE } from "../src/claude-send.mjs";

const scratch = fileURLToPath(new URL("../tmp/agent-claude-send/", import.meta.url));
fs.mkdirSync(scratch, { recursive: true });

test("a process is inside a Claude session only when one of its ancestors is a registered session", async () => {
  const tree = { 50: 40, 40: 30, 30: 1 };
  const parentOf = pid => tree[pid];
  assert.equal(await insideClaudeSession({ pid: 50, parentOf, list: async () => [{ pid: 30 }] }), true);
  assert.equal(await insideClaudeSession({ pid: 50, parentOf, list: async () => [{ pid: 50 }] }), true);
  assert.equal(await insideClaudeSession({ pid: 50, parentOf, list: async () => [{ pid: 77 }] }), false);
  // A sandbox that forbids ps, a broken answer or an unreadable registry all mean "not inside".
  assert.equal(await insideClaudeSession({ pid: 50, parentOf: () => { throw new Error("spawn EPERM"); }, list: async () => [{ pid: 30 }] }), false);
  assert.equal(await insideClaudeSession({ pid: 50, parentOf: () => NaN, list: async () => [{ pid: 30 }] }), false);
  assert.equal(await insideClaudeSession({ pid: 50, parentOf, list: async () => { throw new Error("EACCES"); } }), false);
  // A loop in the answers ends.
  assert.equal(await insideClaudeSession({ pid: 50, parentOf: () => 50, list: async () => [{ pid: 30 }] }), false);
});

function harness({ inside, receipt = "recorded", status = "idle" } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, "run-"));
  const socket = path.join(dir, "peer.sock");
  fs.writeFileSync(socket, "");
  const log = { sends: [], registered: 0, cleaned: 0, confirms: [] };
  const target = { pid: 4242, sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/work/p", status, messagingSocketPath: "/fixture/t.sock" };
  const options = {
    target: "4242", message: "hello", inside: async () => inside, resolve: async () => target, mark: () => 10, hasRecord: () => true,
    send: async input => { log.sends.push(input); return { msgId: "m-1", target }; },
    register: async () => { log.registered++; return { socketPath: socket, sessionId: "peer-session", cleanup: () => { log.cleaned++; } }; },
    confirm: async input => { log.confirms.push({ ...input, registeredNow: log.registered - log.cleaned }); return receipt; },
  };
  return { log, options, socket: fs.realpathSync(socket), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("inside a Claude session the message is sent as before and the receipt comes from the session's record", async t => {
  const h = harness({ inside: true });
  t.after(h.cleanup);
  const result = await sendToClaude(h.options);
  assert.deepEqual(result, { msgId: "m-1", target: h.log.sends[0].target, receipt: "recorded", via: "direct" });
  assert.equal(h.log.registered, 0);
  assert.equal(h.log.sends[0].fromAddress, undefined);
  assert.deepEqual([h.log.confirms[0].msgId, h.log.confirms[0].offset, h.log.confirms[0].sessionId], ["m-1", 10, "11111111-2222-4333-8444-555555555555"]);
});

test("outside a Claude session a send without a declared mode is refused before anything is written", async t => {
  const h = harness({ inside: false });
  t.after(h.cleanup);
  await assert.rejects(sendToClaude(h.options), error => error.message === NEEDS_MODE);
  await assert.rejects(sendToClaude({ ...h.options, fromMode: "yolo" }), /--from-mode prompting\|bypass/);
  assert.deepEqual([h.log.sends.length, h.log.registered], [0, 0]);
});

test("outside a Claude session the sender registers as a peer, declares its mode, and is removed when the send ends", async t => {
  const h = harness({ inside: false });
  t.after(h.cleanup);
  const result = await sendToClaude({ ...h.options, fromMode: "prompting", fromName: "opencode" });
  assert.equal(result.via, "registered-peer");
  assert.deepEqual([h.log.sends[0].fromAddress, h.log.sends[0].fromSessionId, h.log.sends[0].fromMode], [`uds:${h.socket}`, "peer-session", "prompting"]);
  // The registration is still there while the receipt is read, and gone afterwards, also when the send fails.
  assert.equal(h.log.confirms[0].registeredNow, 1);
  assert.deepEqual([h.log.registered, h.log.cleaned], [1, 1]);
  await assert.rejects(sendToClaude({ ...h.options, fromMode: "bypass", send: async () => { throw new Error("socket closed"); } }), /socket closed/);
  assert.deepEqual([h.log.registered, h.log.cleaned], [2, 2]);
});

test("a sender that names its own registered peer is not registered again", async t => {
  const h = harness({ inside: false });
  t.after(h.cleanup);
  const result = await sendToClaude({ ...h.options, fromAddress: "uds:/fixture/listener.sock", fromSessionId: "listener" });
  assert.equal(result.via, "direct");
  assert.equal(h.log.registered, 0);
  assert.equal(h.log.sends[0].fromAddress, "uds:/fixture/listener.sock");
});

test("an unconfirmed receipt says why it may be so, and a busy session is not called a failure", async t => {
  const held = harness({ inside: true, receipt: "unconfirmed" });
  const busy = harness({ inside: true, receipt: "unconfirmed", status: "busy" });
  t.after(held.cleanup); t.after(busy.cleanup);
  assert.match((await sendToClaude(held.options)).note, /held for approval in the Claude app/);
  assert.match((await sendToClaude(busy.options)).note, /busy: it writes the message down when its current step ends/);
  // A listener (a registered name with no transcript) or a bare socket path takes any frame: nothing is registered
  // for it, no mode is demanded even from outside a Claude session, and its receipt stays unknown.
  for (const resolve of [async () => ({ pid: 9, messagingSocketPath: "/fixture/l.sock" }),
    async () => ({ pid: 9, sessionId: "22222222-2222-4333-8444-555555555555", cwd: "/work/p", messagingSocketPath: "/fixture/l.sock" })]) {
    const listener = harness({ inside: false });
    t.after(listener.cleanup);
    const result = await sendToClaude({ ...listener.options, resolve, hasRecord: () => false });
    assert.deepEqual([result.receipt, result.via], ["unknown", "direct"]);
    assert.match(result.note, /cannot be confirmed/);
    assert.deepEqual([listener.log.confirms.length, listener.log.registered, listener.log.sends.length], [0, 0, 1]);
  }
});

test("a declared mode that differs from the session's own mode is named as the reason a message is held", async () => {
  const { modeMismatch } = await import("../src/claude-send.mjs");
  assert.match(modeMismatch("prompting", "bypassPermissions"), /declared --from-mode prompting.*runs in bypassPermissions.*holds such a message/);
  assert.match(modeMismatch("bypass", "default"), /declared --from-mode bypass.*runs in default/);
  assert.match(modeMismatch("bypass", "acceptEdits"), /never declare bypass unless/);
  for (const [from, mode] of [["bypass", "bypassPermissions"], ["prompting", "default"], ["prompting", "plan"], [undefined, "default"], ["bypass", "unknown"], ["bypass", undefined], ["bypass", ""]]) {
    assert.equal(modeMismatch(from, mode), undefined);
  }
});
