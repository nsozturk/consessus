import { setTimeout as sleep } from "node:timers/promises";
import { bounded } from "./codex-replies.mjs";

export const SESSION_ID = /^ses_?[A-Za-z0-9]{1,128}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9]{1,128}$/;

export function loopback(server) {
  let url;
  try { url = new URL(server); } catch {}
  if (!url || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OpenCode delivery only talks to a loopback HTTP server such as http://127.0.0.1:<port>");
  }
  return url.origin;
}

const textOf = message => message?.type === "assistant" && Array.isArray(message.content)
  ? message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";

// Polls the session's message list (GET only) for the turn that followed our own message. `after` is the
// id the server gave that message when it admitted it, and the list keeps it. The server records an "idle"
// message when a turn ends, so the answer is the last assistant text between the two. Nothing older than
// the marker is ever looked at, and a turn with no idle marker yet is not an answer.
export async function readOpencodeReply({ session, after, timeoutMs = 120_000, pollMs = 1000, server, headers = {}, request = fetch } = {}) {
  if (typeof session !== "string" || !SESSION_ID.test(session)) throw new Error("Invalid OpenCode session id");
  if (typeof after !== "string" || !MESSAGE_ID.test(after)) throw new Error("after must be the message id marker deliver returned");
  if (!(timeoutMs >= 0) || !(pollMs > 0)) throw new Error("timeoutMs and pollMs must be positive numbers");
  const origin = loopback(server);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    let page;
    try {
      // ponytail: one page of the newest 200. A turn that adds more than 200 messages after the marker
      // pushes the marker out of the page and ends as "timeout"; follow cursor.next if that ever happens.
      const reply = await request(`${origin}/api/session/${session}/message?order=desc&limit=200`,
        { headers, signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(3000, deadline - performance.now())))) });
      if (!reply.ok) return { status: "unavailable", reason: `HTTP ${reply.status}` };
      page = (await reply.json())?.data;
    } catch (error) {
      if (performance.now() >= deadline) return { status: "timeout" };
      return { status: "unavailable", reason: error?.name === "TimeoutError" ? "no answer from the server" : "unreachable" };
    }
    if (!Array.isArray(page)) return { status: "unavailable", reason: "unexpected message list" };
    const marker = page.findIndex(message => message?.id === after);
    // Newest first, so everything before the marker's position came after it. No marker in the page: nothing is ours.
    const since = marker === -1 ? [] : page.slice(0, marker).reverse();
    const end = since.findIndex(message => message?.type === "idle");
    if (end !== -1) {
      const text = since.slice(0, end).map(textOf).filter(Boolean).at(-1);
      if (text) return { status: "replied", ...bounded(text) };
      const outcome = since[end].outcome;
      return { status: "no-reply", ...(["failed", "interrupted"].includes(outcome) ? { outcome } : {}) };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { status: "timeout" };
    await sleep(Math.min(pollMs, remaining));
  }
}
