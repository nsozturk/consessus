import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bounded } from "./codex-replies.mjs";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_STEP = 8 * 1024 * 1024, MAX_HELD = 256 * 1024;

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

// Claude Code keeps one transcript per session, in a folder named after the session's directory with
// every character that is not a letter or digit turned into "-".
export function claudeTranscript({ sessionId, cwd, home = claudeHome() }) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("A full Claude session id is required");
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("The Claude session's directory is required");
  return path.join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

// Reads whole lines from `offset` on; a negative offset counts back from the end of the file.
// Only the owner's own regular file is read, never through a link.
function readFrom(file, offset, uid) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return undefined;
    if (offset < 0) offset = Math.max(0, stat.size + offset);
    if (stat.size < offset) return { lines: [], offset: stat.size };
    const chunk = Buffer.alloc(Math.min(stat.size - offset, MAX_STEP));
    const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
    // A line still being written has no newline yet: it is left for the next read.
    const end = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (end === -1) return { lines: [], offset: read === MAX_STEP ? offset + read : offset };
    return { lines: chunk.subarray(0, end).toString("utf8").split("\n"), offset: offset + end + 1, from: offset };
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// The whole lines in the last `bytes` of a session's transcript, under the same file checks. A read that
// starts inside the file starts inside a line, so its first piece is dropped.
export function readClaudeTail(session, bytes, { home = claudeHome(), uid = process.getuid() } = {}) {
  if (!(bytes > 0 && bytes <= MAX_STEP)) throw new Error("bytes must be a positive number within the read limit");
  const step = readFrom(claudeTranscript({ ...session, home }), -bytes, uid);
  if (!step) return undefined;
  return step.from > 0 ? step.lines.slice(1) : step.lines;
}

// The size of the transcript now, taken before a send so the search for our message starts there.
export function claudeTranscriptMark(session, uid = process.getuid()) {
  try {
    const stat = fs.lstatSync(claudeTranscript(session));
    return stat.isFile() && stat.uid === uid ? stat.size : 0;
  } catch { return 0; }
}

// Waits for the turn that answered OUR message and returns its final text. `after.msgId` is the id the
// frame carried; the transcript records it on the user line, so nothing before that line is ever looked
// at and a message from someone else is never taken for ours. The turn is over at the "turn_duration"
// line Claude Code writes after every finished turn. Reasoning, tool calls and tool results are never read.
export async function readClaudeReply({ sessionId, cwd, after, timeoutMs = 120_000, pollMs = 500, signal,
  home = claudeHome(), uid = process.getuid() } = {}) {
  const file = claudeTranscript({ sessionId, cwd, home });
  if (typeof after?.msgId !== "string" || !after.msgId) throw new Error("after.msgId must be the id of the message that was sent");
  if (!(timeoutMs >= 0) || !(pollMs > 0)) throw new Error("timeoutMs and pollMs must be positive numbers");
  const deadline = performance.now() + timeoutMs;
  let offset = Number.isSafeInteger(after.offset) && after.offset > 0 ? after.offset : 0;
  let ours = false, answer = { id: undefined, text: "" };
  for (;;) {
    const step = readFrom(file, offset, uid);
    if (!step) return { status: "unavailable", reason: "the session's transcript could not be read" };
    offset = step.offset;
    for (const line of step.lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== "object" || row.sessionId !== sessionId || row.isSidechain === true) continue;
      if (!ours) {
        ours = row.type === "user" && row.origin?.kind === "peer" && row.origin.msg_id === after.msgId;
        continue;
      }
      if (row.type === "assistant" && Array.isArray(row.message?.content)) {
        const text = row.message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
        if (!text) continue;
        // Only the last assistant message of the turn is the answer; earlier ones are notes between tool calls.
        answer = row.message.id === answer.id ? { id: answer.id, text: `${answer.text}\n${text}` } : { id: row.message.id, text };
        if (answer.text.length > MAX_HELD) answer.text = answer.text.slice(0, MAX_HELD);
      } else if (row.type === "system" && row.subtype === "turn_duration") {
        return answer.text.trim() ? { status: "replied", ...bounded(answer.text) } : { status: "no-reply" };
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { status: "timeout" };
    // More lines may already be waiting after a full read; otherwise wait for the session to write.
    if (!step.lines.length) await sleep(Math.min(pollMs, remaining), undefined, { signal });
  }
}
