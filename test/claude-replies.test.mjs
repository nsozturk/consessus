import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeTranscript, claudeTranscriptMark, readClaudeReply } from "../src/claude-replies.mjs";

const scratch = fileURLToPath(new URL("../tmp/agent-claude-replies/", import.meta.url));
fs.mkdirSync(scratch, { recursive: true });
const SESSION = "11111111-2222-4333-8444-555555555555", CWD = "/work/demo_project";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(scratch, "run-"));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  const file = claudeTranscript({ sessionId: SESSION, cwd: CWD, home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { sessionId: SESSION, isSidechain: false };
  const rows = {
    peer: msgId => ({ ...base, type: "user", origin: { kind: "peer", msg_id: msgId }, message: { role: "user", content: "peer text" } }),
    typed: () => ({ ...base, type: "user", message: { role: "user", content: "typed by the owner" } }),
    say: (id, ...blocks) => ({ ...base, type: "assistant", message: { id, content: blocks } }),
    end: () => ({ ...base, type: "system", subtype: "turn_duration" }),
  };
  const text = value => ({ type: "text", text: value }), thinking = value => ({ type: "thinking", thinking: value });
  const tool = () => ({ type: "tool_use", name: "Bash", input: { command: "secret command" } });
  const write = (...list) => fs.appendFileSync(file, list.map(row => JSON.stringify(row) + "\n").join(""), { mode: 0o600 });
  const read = (msgId, extra = {}) => readClaudeReply({ sessionId: SESSION, cwd: CWD, home, after: { msgId }, timeoutMs: 300, pollMs: 5, ...extra });
  return { home, file, rows, text, thinking, tool, write, read };
}

test("the transcript path follows Claude Code's folder naming and refuses anything that is not a full session id", () => {
  assert.equal(claudeTranscript({ sessionId: SESSION, cwd: "/work/demo_project/.x", home: "/h" }), `/h/projects/-work-demo-project--x/${SESSION}.jsonl`);
  for (const sessionId of ["../../etc/passwd", "1111", `${SESSION}/x`, undefined]) {
    assert.throws(() => claudeTranscript({ sessionId, cwd: CWD, home: "/h" }), /session id/);
  }
  assert.throws(() => claudeTranscript({ sessionId: SESSION, cwd: "relative", home: "/h" }), /directory/);
});

test("returns the final text of the turn that answered our message, and nothing written before it", async t => {
  const f = fixture(t);
  f.write(f.rows.peer("other"), f.rows.say("m0", f.text("answer to an earlier message")), f.rows.end(),
    f.rows.peer("ours"), f.rows.say("m1", f.thinking("hidden reasoning")), f.rows.say("m1", f.text("a note before a tool call")), f.rows.say("m1", f.tool()),
    { sessionId: SESSION, type: "user", message: { content: [{ type: "tool_result", content: "tool output" }] } },
    f.rows.say("m2", f.thinking("more reasoning")), f.rows.say("m2", f.text("the answer")), f.rows.say("m2", f.text("second paragraph")), f.rows.end(),
    f.rows.peer("later"), f.rows.say("m3", f.text("answer to a later message")), f.rows.end());
  assert.deepEqual(await f.read("ours"), { status: "replied", text: "the answer\nsecond paragraph" });
});

test("half an answer is not an answer: it waits for the end of the turn, and times out if the turn never ends", { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.write(f.rows.peer("ours"), f.rows.say("m1", f.text("first words")));
  const pending = f.read("ours", { timeoutMs: 400 });
  setTimeout(() => f.write(f.rows.say("m1", f.text("last words")), f.rows.end()), 60);
  assert.deepEqual(await pending, { status: "replied", text: "first words\nlast words" });
  const g = fixture(t);
  g.write(g.rows.peer("ours"), g.rows.say("m1", g.text("never finished")));
  assert.deepEqual(await g.read("ours", { timeoutMs: 60 }), { status: "timeout" });
});

test("a message that was never recorded, another session's lines and sidechains give no answer", { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.write(f.rows.peer("someone-else"), f.rows.say("m1", f.text("not for us")), f.rows.end());
  assert.deepEqual(await f.read("ours", { timeoutMs: 40 }), { status: "timeout" });
  f.write(f.rows.typed(), f.rows.say("m2", f.text("answer to the owner")), f.rows.end());
  assert.deepEqual(await f.read("ours", { timeoutMs: 40 }), { status: "timeout" });
  const g = fixture(t);
  g.write(g.rows.peer("ours"), { ...g.rows.say("side", g.text("subagent chatter")), isSidechain: true },
    { ...g.rows.say("alien", g.text("another session")), sessionId: "99999999-2222-4333-8444-555555555555" }, g.rows.end());
  assert.deepEqual(await g.read("ours"), { status: "no-reply" });
});

test("a torn last line is left for the next read, and the mark lets the search start after old content", async t => {
  const f = fixture(t);
  f.write(f.rows.peer("ours"), f.rows.say("m1", f.text("old turn")), f.rows.end());
  const offset = claudeTranscriptMark({ sessionId: SESSION, cwd: CWD, home: f.home });
  assert.equal(offset, fs.statSync(f.file).size);
  // The same id again after the mark: only the new turn is read.
  f.write(f.rows.peer("ours"));
  fs.appendFileSync(f.file, JSON.stringify(f.rows.say("m2", f.text("new turn"))).slice(0, 40));
  const pending = readClaudeReply({ sessionId: SESSION, cwd: CWD, home: f.home, after: { msgId: "ours", offset }, timeoutMs: 400, pollMs: 5 });
  setTimeout(() => { fs.appendFileSync(f.file, JSON.stringify(f.rows.say("m2", f.text("new turn"))).slice(40) + "\n"); f.write(f.rows.end()); }, 50);
  assert.deepEqual(await pending, { status: "replied", text: "new turn" });
  assert.equal(claudeTranscriptMark({ sessionId: SESSION, cwd: "/work/none", home: f.home }), 0);
});

test("a long answer is cut at 64 KiB on a character boundary", async t => {
  const f = fixture(t);
  f.write(f.rows.peer("ours"), f.rows.say("m1", f.text("é".repeat(60_000))), f.rows.end());
  const result = await f.read("ours");
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.text), 64 * 1024);
  assert.doesNotMatch(result.text, /�/);
});

test("a missing file, a link, a file others can write or someone else's file is unavailable, never read", async t => {
  const f = fixture(t);
  assert.equal((await f.read("ours")).status, "unavailable");
  f.write(f.rows.peer("ours"), f.rows.say("m1", f.text("private")), f.rows.end());
  assert.equal((await f.read("ours", { uid: process.getuid() + 1 })).status, "unavailable");
  fs.chmodSync(f.file, 0o666);
  assert.equal((await f.read("ours")).status, "unavailable");
  fs.chmodSync(f.file, 0o600);
  const real = `${f.file}.real`;
  fs.renameSync(f.file, real);
  fs.symlinkSync(real, f.file);
  assert.equal((await f.read("ours")).status, "unavailable");
});

test("the wait stops when its signal aborts, and bad arguments are refused before any file is opened", async t => {
  const f = fixture(t);
  f.write(f.rows.peer("ours"));
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(f.read("ours", { timeoutMs: 5000, signal: stop.signal }), { name: "AbortError" });
  await assert.rejects(readClaudeReply({ sessionId: SESSION, cwd: CWD, home: f.home, after: {} }), /after\.msgId/);
  await assert.rejects(f.read("ours", { pollMs: 0 }), /positive/);
});
