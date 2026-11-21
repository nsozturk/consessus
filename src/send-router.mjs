import { randomUUID } from "node:crypto";
import { formatPeerData } from "./agent-inbox.mjs";
import { listSessions } from "./sessions.mjs";
import { modeHint } from "./permission-modes.mjs";
import { sendMessageToSession } from "./index.mjs";
import { startCodexDesktop, steerCodexDesktop } from "./codex-desktop.mjs";
import { connectAntigravity, openAntigravityDelivery, readAntigravityReply } from "./antigravity-delivery.mjs";
import { openOpencodeDelivery } from "./opencode-delivery.mjs";
import { readCodexReply } from "./codex-replies.mjs";
import { readClaudeReply } from "./claude-replies.mjs";
import { modeMismatch, sendToClaude } from "./claude-send.mjs";

// One address space for the four apps: a session id (or a unique prefix of it), optionally "app:id".
export function resolveTarget(query, sessions, unavailable = []) {
  if (typeof query !== "string" || !query.trim()) throw new Error("A session id is required. Run `consessus sessions` to see them.");
  const split = /^(claude|codex|antigravity|opencode):(.+)$/.exec(query.trim());
  const app = split?.[1], id = split ? split[2] : query.trim();
  if (id.length < 6) throw new Error("Give at least 6 characters of the session id");
  const pool = sessions.filter(row => !app || row.app === app);
  const exact = pool.filter(row => row.id === id);
  const found = exact.length ? exact : pool.filter(row => typeof row.id === "string" && row.id.startsWith(id));
  if (found.length === 1) return found[0];
  if (!found.length) {
    // "Not found" is only true for an app whose list was read. Say which lists were not, and why.
    const unread = unavailable.filter(entry => !app || entry.app === app);
    const hints = unread.map(entry => `The ${entry.app} sessions could not be listed (${String(entry.reason).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 120)}), so the session may still be open.`);
    if (app === "opencode" || /^ses_/.test(id)) hints.push("A session of the OpenCode desktop app is not listed: start a listener inside it with `consessus agent --name <name> --inbox --opencode-session auto` and send to that listener.");
    throw new Error(["No listed session matches that id. Run `consessus sessions` to see them.", ...hints].join(" "));
  }
  throw new Error(`${found.length} sessions match that id: ${found.map(row => `${row.app}:${row.id}`).join(", ")}. Give more of it.`);
}

export const defaultTransports = ({ openOpencode = openOpencodeDelivery, sendClaude = sendToClaude } = {}) => ({
  async claude(row, { message, fromName, fromMode }) {
    const session = { sessionId: row.id, cwd: row.path };
    // A socket write proves nothing. The session's own record does: "recorded" means Claude Code wrote our message down.
    const sent = await sendClaude({ target: row.id, message, fromName, fromMode, status: row.status });
    // The reader finds our own message by its id, so a turn that was already running cannot be mistaken for the answer.
    // A busy session takes the message into its running turn, so there is no turn of our own to read an answer from.
    const mismatch = sent.receipt === "recorded" ? undefined : modeMismatch(fromMode, row.mode);
    return { status: sent.receipt === "recorded" ? "delivered" : "sent", receipt: sent.receipt, busy: row.status === "busy",
      ...(mismatch ? { note: mismatch } : sent.note ? { note: sent.note } : {}),
      ...(sent.via === "registered-peer" ? { via: sent.via } : {}),
      ...(row.path ? { readReply: ({ timeoutMs }) => readClaudeReply({ ...session, after: { msgId: sent.msgId }, ...(timeoutMs ? { timeoutMs } : {}) }) } : {}) };
  },
  // A running turn takes the message as an addition; an idle chat gets a new turn.
  async codex(row, { text }) {
    const steered = await steerCodexDesktop({ threadId: row.id, text, messageId: randomUUID() });
    const result = steered.status === "queue" ? await startCodexDesktop({ threadId: row.id, text, messageId: randomUUID() }) : steered;
    const delivered = ["started", "steered", "accepted"].includes(result.status);
    // Only a turn this call started has an id of its own to wait for. A steered turn was already running.
    const turn = result.status === "started" && typeof result.turnId === "string" ? result.turnId : undefined;
    return { status: delivered ? "delivered" : "failed", busy: steered.status !== "queue", ...(delivered ? {} : { reason: result.reason ?? result.status }),
      ...(turn ? { readReply: ({ timeoutMs }) => readCodexReply({ thread: row.id, turn, ...(timeoutMs ? { timeoutMs } : {}) }) } : {}) };
  },
  async antigravity(row, { frame }) {
    // The id came from the server's own list a moment ago, so the folder check is not repeated here.
    const delivery = await openAntigravityDelivery({ conversation: row.id, anyProject: true, senderTitle: true });
    const sent = await delivery.deliver(frame);
    return { ...sent, ...(Number.isSafeInteger(sent.afterStep)
      ? { readReply: ({ timeoutMs }) => readAntigravityReply({ conversation: row.id, afterStep: sent.afterStep, ...(timeoutMs ? { timeoutMs } : {}) }) } : {}) };
  },
  async opencode(row, { frame }) {
    const delivery = await openOpencode({ session: row.id, cwd: row.path ?? process.cwd() });
    const sent = await delivery.deliver(frame);
    // Only the CLI service returns the id of the message it admitted; without it there is nothing to read after.
    return { ...sent, ...(typeof sent.after === "string"
      ? { readReply: ({ timeoutMs }) => delivery.readReply({ after: sent.after, ...(timeoutMs ? { timeoutMs } : {}) }) } : {}) };
  },
});

export async function sendToSession({ to, message, project, fromName = "consessus", fromMode, read = false, timeoutMs,
  list = listSessions, transports = defaultTransports() } = {}) {
  if (typeof message !== "string" || !message.trim()) throw new Error("A message is required");
  const listed = await list({ project });
  const row = resolveTarget(to, listed.sessions, listed.unavailable ?? []);
  const transport = transports[row.app];
  if (typeof transport !== "function") throw new Error(`${row.app} sessions cannot be reached by this version`);
  const frame = { type: "user", from_name: fromName, message: { content: message } };
  const sent = await transport(row, { message, fromName, fromMode, frame, text: formatPeerData(frame) });
  const { readReply, ...outcome } = sent ?? {};
  const result = { app: row.app, id: row.id, path: row.path ?? null, ...outcome };
  // The mode is only reported. Changing it is the owner's own action in that app.
  if (row.asks === "always" || row.asks === "sometimes") {
    result.warning = `That ${row.app} session is set to ask before running tools (${row.mode}), so its answer may wait for approval there. ${modeHint(row.app)}`;
  }
  if (read && result.status !== "failed") {
    if (typeof readReply !== "function") result.reply = { status: "not-read", reason: `reading replies is not supported for ${row.app} sessions yet` };
    else if (result.busy) result.reply = { status: "not-read", reason: "the session was busy when the message arrived, so a reply could belong to its earlier turn" };
    // Unknown is not idle: without a clear "not busy" a finished earlier turn could be taken for the answer.
    else if (result.busy !== false) result.reply = { status: "not-read", reason: "the session's state could not be read when the message arrived, so a reply could belong to an earlier turn" };
    else result.reply = await readReply({ timeoutMs });
  }
  return result;
}
