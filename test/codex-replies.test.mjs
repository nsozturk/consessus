import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexReply } from "../src/codex-replies.mjs";

// A store whose turn row changes over successive polls.
function store(sequence, items = {}) {
  let polls = 0, closed = 0;
  return { stats: () => ({ polls, closed }), open: () => ({
    turn: () => sequence[Math.min(polls++, sequence.length - 1)],
    item: (_thread, _turn, id) => items[id],
    close: () => { closed++; },
  }) };
}
const base = { thread: "t1", turn: "turn-1", pollMs: 5, timeoutMs: 400 };

test("waits for the turn it started to finish and returns only that turn's final answer", async () => {
  const s = store([undefined, { status: "inProgress" }, { status: "completed", final_agent_item_id: "a2" }],
    { a1: JSON.stringify({ type: "agentMessage", text: "interim" }), a2: JSON.stringify({ type: "agentMessage", text: "final answer" }) });
  assert.deepEqual(await readCodexReply({ ...base, open: s.open }), { status: "replied", text: "final answer" });
  assert.equal(s.stats().polls, 3);
  assert.equal(s.stats().closed, 1);
});

test("reports a failed or interrupted turn, a finished turn without an answer, and a timeout", { timeout: 5000 }, async t => {
  for (const status of ["failed", "interrupted"]) {
    assert.deepEqual(await readCodexReply({ ...base, open: store([{ status }]).open }), { status });
  }
  assert.deepEqual(await readCodexReply({ ...base, open: store([{ status: "completed", final_agent_item_id: null }]).open }), { status: "no-reply" });
  assert.deepEqual(await readCodexReply({ ...base, open: store([{ status: "completed", final_agent_item_id: "gone" }]).open }), { status: "no-reply" });
  assert.deepEqual(await readCodexReply({ ...base, open: store([{ status: "completed", final_agent_item_id: "u" }], { u: JSON.stringify({ type: "userMessage", text: "not an answer" }) }).open }), { status: "no-reply" });
  const slow = store([{ status: "inProgress" }]);
  assert.deepEqual(await readCodexReply({ ...base, timeoutMs: 40, signal: t.signal, open: slow.open }), { status: "timeout" });
  assert.equal(slow.stats().closed, 1);
  assert.deepEqual(await readCodexReply({ ...base, timeoutMs: 40, signal: t.signal, open: store([undefined]).open }), { status: "timeout" });
});

test("bounds a huge answer, rejects bad arguments and says so when the history cannot be opened", async () => {
  const big = "é".repeat(40000);
  const reply = await readCodexReply({ ...base, open: store([{ status: "completed", final_agent_item_id: "a" }], { a: JSON.stringify({ type: "agentMessage", text: big }) }).open });
  assert.equal(reply.truncated, true);
  assert.ok(Buffer.byteLength(reply.text) <= 65536);
  assert.ok(!reply.text.includes("�"));
  await assert.rejects(readCodexReply({ ...base, turn: "" }), /turn id/);
  await assert.rejects(readCodexReply({ ...base, thread: 5 }), /thread id/);
  assert.deepEqual(await readCodexReply({ ...base, open: () => { throw new Error("no sqlite"); } }), { status: "unavailable", reason: "no sqlite" });
});

test("stops waiting and closes the history when its signal aborts", async () => {
  const s = store([{ status: "inProgress" }]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(readCodexReply({ ...base, timeoutMs: 4000, signal: stop.signal, open: s.open }), { name: "AbortError" });
  assert.equal(s.stats().closed, 1);
  const done = store([{ status: "completed", final_agent_item_id: null }]);
  assert.deepEqual(await readCodexReply({ ...base, signal: AbortSignal.abort(), open: done.open }), { status: "no-reply" },
    "a turn that already finished is still reported");
});

test("reads a real history database read-only", { timeout: 5000 }, async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { t.skip("node:sqlite is not available"); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "consessus-codex-"));
  const db = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  db.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, final_agent_item_id TEXT);"
    + "CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, item_json TEXT);");
  db.prepare("INSERT INTO thread_turns VALUES (?,?,?,?)").run("t1", "turn-1", "completed", "a1");
  db.prepare("INSERT INTO thread_turns VALUES (?,?,?,?)").run("t1", "turn-0", "completed", "a0");
  db.prepare("INSERT INTO thread_items VALUES (?,?,?,?,?)").run("t1", "turn-1", "a1", "agentMessage", JSON.stringify({ type: "agentMessage", text: "mine" }));
  db.prepare("INSERT INTO thread_items VALUES (?,?,?,?,?)").run("t1", "turn-0", "a0", "agentMessage", JSON.stringify({ type: "agentMessage", text: "earlier turn" }));
  db.close();
  assert.deepEqual(await readCodexReply({ ...base, home }), { status: "replied", text: "mine" });
  assert.deepEqual(await readCodexReply({ ...base, turn: "turn-9", timeoutMs: 30, signal: t.signal, home }), { status: "timeout" });
});
