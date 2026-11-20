import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LIMIT = 64 * 1024;

// The desktop app records every turn in its local history database. Reading the turn that
// our own start request created is enough to get the answer, with no subscription and no
// request sent to the app. The database is opened read-only and nothing else is read from it.
async function openHistory(home) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(home, "thread_history_1.sqlite"), { readOnly: true });
  const turn = db.prepare("SELECT status, final_agent_item_id FROM thread_turns WHERE thread_id = ? AND turn_id = ?");
  const item = db.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?");
  return {
    turn: (thread, id) => turn.get(thread, id),
    item: (thread, id, itemId) => item.get(thread, id, itemId)?.item_json,
    close: () => db.close(),
  };
}

export function bounded(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= LIMIT) return { text };
  let end = LIMIT;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

// `signal` lets the caller stop the wait: the poll then rejects with an AbortError and the history is closed.
export async function readCodexReply({ thread, turn, timeoutMs = 120_000, pollMs = 500, signal,
  home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), open = () => openHistory(home) } = {}) {
  if (typeof thread !== "string" || !thread) throw new Error("A Codex thread id is required");
  if (typeof turn !== "string" || !turn) throw new Error("The turn id returned by the start request is required");
  let history;
  try { history = await open(); }
  catch (error) { return { status: "unavailable", reason: error?.message ?? "the Codex history could not be opened" }; }
  try {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const row = history.turn(thread, turn);
      if (row && row.status !== "inProgress") {
        if (row.status !== "completed") return { status: row.status === "failed" ? "failed" : "interrupted" };
        let answer;
        try { answer = JSON.parse(history.item(thread, turn, row.final_agent_item_id) ?? "null"); } catch {}
        return answer?.type === "agentMessage" && typeof answer.text === "string" && answer.text
          ? { status: "replied", ...bounded(answer.text) } : { status: "no-reply" };
      }
      if (performance.now() >= deadline) return { status: "timeout" };
      await sleep(Math.min(pollMs, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
  } finally { history.close(); }
}
