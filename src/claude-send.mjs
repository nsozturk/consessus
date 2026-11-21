import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { listLiveSessions, resolveTargetSession, sendMessageToSession, startPeerAgentDaemon, validateSenderMode } from "./index.mjs";
import { claudeTranscript, claudeTranscriptMark, confirmClaudeDelivery } from "./claude-replies.mjs";

// Is this process running inside a Claude session (one of its ancestors is a registered session)?
// Measured on 2026-11-20: Claude takes a bare frame only from such a process. From any other process (another
// app's shell, a detached job) the message is held for approval in the Claude app ("the sender did not state its permission mode") or dropped, unless the sender is a registered peer that declares
// its mode. Where the process tree cannot be read (a sandbox that forbids ps) the answer is "no".
export async function insideClaudeSession({ pid = process.pid, list = listLiveSessions,
  parentOf = child => Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(child)], { encoding: "utf8", timeout: 3000 }).trim()) } = {}) {
  try {
    const sessions = new Set((await list()).map(session => session.pid));
    for (let current = pid, depth = 0; current > 1 && depth < 16; depth++) {
      if (sessions.has(current)) return true;
      current = parentOf(current);
      if (!Number.isSafeInteger(current)) return false;
    }
  } catch {}
  return false;
}

export const NEEDS_MODE = "This shell is not inside a Claude session. Claude accepts a message from outside only from a registered peer that declares its own approval policy: add --from-mode prompting (you ask your owner before acting) or --from-mode bypass (you act without permission prompts: an auto-accept, turbo or full-access session). State the mode you really run in: the Claude app holds a message whose declared mode differs from the receiving session's mode.";

// Sends to a Claude session and says what its own record shows. Outside a Claude session the sender is first
// registered as a peer for the length of the send, because a bare frame from there is held or dropped without a word to the sender.
export async function sendToClaude({ target, message, fromName = "consessus", fromMode, fromAddress, fromSessionId, priority, raw, status,
  waitMs = 4000, inside = insideClaudeSession, resolve = resolveTargetSession, send = sendMessageToSession,
  register = startPeerAgentDaemon, mark = claudeTranscriptMark, confirm = confirmClaudeDelivery,
  hasRecord = session => { try { return fs.existsSync(claudeTranscript(session)); } catch { return false; } } } = {}) {
  if (fromMode !== undefined) validateSenderMode(fromMode);
  const resolved = typeof target === "object" && target !== null ? target : await resolve(target);
  // Only a real Claude session keeps a transcript. A Consessus listener or a bare socket path keeps none: it takes
  // any frame, so nothing is registered for it and its receipt stays unknown.
  const named = resolved.sessionId && resolved.cwd ? { sessionId: resolved.sessionId, cwd: resolved.cwd } : undefined;
  const session = named && hasRecord(named) ? named : undefined;
  const explicit = fromAddress !== undefined || fromSessionId !== undefined;
  const direct = !session || explicit || await inside();
  if (!direct && fromMode === undefined) throw new Error(NEEDS_MODE);
  let offset;
  try { if (session) offset = mark(session); } catch {}
  let peer;
  try {
    if (!direct) {
      peer = await register({ name: `send-${fromName}`.slice(0, 60), cwd: process.cwd(), onFrame() {} });
      fromAddress = `uds:${fs.realpathSync(peer.socketPath)}`;
      fromSessionId = peer.sessionId;
    }
    const sent = await send({ target: resolved, message, fromName, fromMode, fromAddress, fromSessionId, ...(priority ? { priority } : {}), ...(raw ? { raw } : {}) });
    // The registration stays while the receipt is read: the session may look the sender up when it takes the message.
    const receipt = session && offset !== undefined ? await confirm({ ...session, msgId: sent.msgId, offset, waitMs }) : "unknown";
    const note = receipt === "recorded" ? undefined
      : receipt === "unknown" ? "This target keeps no record Consessus can read (a listener, or a socket path), so delivery cannot be confirmed."
      : (status ?? resolved.status) === "busy" ? "The session is busy: it writes the message down when its current step ends, so it is not confirmed yet."
      : "The session has not recorded the message. It may be held for approval in the Claude app (the sender's mode differs from the session's), or the session does not accept peer messages.";
    return { msgId: sent.msgId, target: sent.target ?? resolved, receipt, via: direct ? "direct" : "registered-peer", ...(note ? { note } : {}) };
  } finally { peer?.cleanup?.(); }
}

// Claude's rule, as measured: a message whose declared sender mode differs from the receiving session's own mode
// is held for the owner's approval in the Claude app. Consessus only says so beforehand; it never picks the mode.
export function modeMismatch(fromMode, sessionMode) {
  if (fromMode === undefined || typeof sessionMode !== "string" || !sessionMode || sessionMode === "unknown") return undefined;
  const receiving = sessionMode === "bypassPermissions" ? "bypass" : "prompting";
  return receiving === fromMode ? undefined
    : `You declared --from-mode ${fromMode}, and that session runs in ${sessionMode}: the Claude app holds such a message until its owner approves it. Declare the mode you really run in; never declare bypass unless you act without permission prompts.`;
}
