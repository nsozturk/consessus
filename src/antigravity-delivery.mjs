import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { formatPeerData } from "./agent-inbox.mjs";
import { isPidAlive } from "./index.mjs";

const SERVICE = "/exa.language_server_pb.LanguageServerService/";
const RUNNING = "CASCADE_RUN_STATUS_RUNNING", IDLE = "CASCADE_RUN_STATUS_IDLE";
const REPLY_LIMIT = 64 * 1024;

// Antigravity's language server writes its port and request token to an owner-only file
// for its own helper tools. That file is the sanctioned source: never take the token from
// another process's arguments or environment.
function readHubs(home, uid) {
  const dir = path.join(home, "daemon");
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(name => name.endsWith(".json")).flatMap(name => {
    let fd;
    try {
      // O_NONBLOCK: opening a FIFO that has no writer would otherwise block for ever.
      fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 65536) return [];
      const hub = JSON.parse(fs.readFileSync(fd, "utf8"));
      const valid = Number.isSafeInteger(hub?.pid) && hub.pid > 1 && Number.isSafeInteger(hub.httpPort)
        && hub.httpPort > 0 && hub.httpPort < 65536 && typeof hub.csrfToken === "string" && hub.csrfToken;
      return valid ? [{ pid: hub.pid, port: hub.httpPort, token: hub.csrfToken }] : [];
    } catch { return []; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}

// Finds the running language server and returns an authenticated caller plus its conversation list.
export async function connectAntigravity({ home = path.join(os.homedir(), ".gemini", "antigravity"),
  isAlive = isPidAlive, request = fetch } = {}) {
  const call = async (hub, method, body) => {
    const reply = await request(`http://127.0.0.1:${hub.port}${SERVICE}${method}`, {
      method: "POST", headers: { "content-type": "application/json", "x-codeium-csrf-token": hub.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    return reply.json();
  };
  // A leftover file can name a pid that now belongs to something else, so the server
  // itself has to answer an authenticated call before it is trusted.
  for (const hub of readHubs(home, process.getuid())) {
    if (!isAlive(hub.pid)) continue;
    try {
      const listed = (await call(hub, "GetAllCascadeTrajectories", { excludeSubtrajectories: true }))?.trajectorySummaries;
      if (listed && typeof listed === "object") return { listed, call: (method, body) => call(hub, method, body) };
    } catch {}
  }
  throw new Error("No running Antigravity language server was found");
}

export const workspaceUris = summary => (summary?.trajectoryMetadata?.workspaces ?? [])
  .map(entry => String(entry?.workspaceFolderAbsoluteUri ?? "").replace(/\/$/, "")).filter(Boolean);

const summaries = async call => (await call("GetAllCascadeTrajectories", { excludeSubtrajectories: true }))?.trajectorySummaries ?? {};
async function stepsOf(call, conversation) {
  const steps = (await call("GetCascadeTrajectorySteps", { cascadeId: conversation }))?.steps;
  if (!Array.isArray(steps)) throw new Error("Unexpected step list");
  return steps;
}

const oneLine = text => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").trim();
// Same name lookup as formatPeerData: the envelope's from-name, else the frame's own name field.
function senderName(frame) {
  let body = frame.message?.content ?? frame.content ?? frame.text;
  if (Array.isArray(body)) body = body.map(block => block?.text).filter(text => typeof text === "string").join("\n");
  const name = (typeof body === "string" ? /^<cross-session-message[^>]*\sfrom-name="([^"]*)"/.exec(body)?.[1] : undefined)
    ?? frame.from_name ?? frame.fromName;
  return (typeof name === "string" && oneLine(name)) || "unknown sender";
}

export async function openAntigravityDelivery({ project = process.cwd(), conversation = "auto", senderTitle = false,
  anyProject = false, ...connection } = {}) {
  const { listed, call } = await connectAntigravity(connection);
  if (anyProject) {
    // For a caller that already picked one conversation from the server's list, whatever its folder.
    if (conversation === "auto") throw new Error("anyProject needs a conversation id");
    if (typeof conversation !== "string" || !Object.hasOwn(listed, conversation)) {
      throw new Error("That id is not a conversation on the running Antigravity server");
    }
  } else {
    const workspace = pathToFileURL(fs.realpathSync.native(project)).href.replace(/\/$/, "");
    const inProject = Object.entries(listed).filter(([, summary]) => workspaceUris(summary).includes(workspace)).map(([id]) => id);
    if (conversation === "auto") {
      if (inProject.length !== 1) {
        throw new Error("Expected exactly one Antigravity conversation for this project. Pass --antigravity-conversation <id>");
      }
      conversation = inProject[0];
    } else if (!inProject.includes(conversation)) {
      throw new Error("That id is not a conversation of this project on the running Antigravity server");
    }
  }

  return {
    conversation,
    // afterStep is the step count just before the send: readAntigravityReply reads only what comes after it.
    async deliver(frame, { title } = {}) {
      if (!["user", "message"].includes(frame?.type)) return { status: "skipped" };
      const state = {};
      try {
        const summary = (await summaries(call))[conversation];
        if (summary) state.busy = summary.status === RUNNING;
      } catch {}
      try { state.afterStep = (await stepsOf(call, conversation)).length; } catch {}
      title ??= senderTitle ? `Consessus: ${senderName(frame)}` : undefined;
      const body = { recipient: conversation, content: formatPeerData(frame) };
      if (typeof title === "string" && oneLine(title)) body.displayTitle = [...oneLine(title)].slice(0, 80).join("");
      try {
        await call("SendAgentMessage", body);
        return { status: "delivered", conversation, ...state };
      } catch (error) {
        const reason = /^HTTP \d+$/.test(error?.message) ? error.message : error?.name === "TimeoutError" ? "timeout" : "unreachable";
        return { status: "failed", conversation, reason };
      }
    },
  };
}

function bounded(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= REPLY_LIMIT) return { text };
  let end = REPLY_LIMIT;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

const answerOf = step => step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" && step.status === "CORTEX_STEP_STATUS_DONE"
  ? [step.plannerResponse?.response, step.plannerResponse?.modifiedResponse].find(text => typeof text === "string" && text) : undefined;

// Polls until the conversation is idle with a finished answer after afterStep. An idle conversation
// that has not started on the message yet is not "no-reply": that needs a run seen since the send.
export async function readAntigravityReply({ conversation, afterStep, timeoutMs = 120_000, pollMs = 1000, ...connection } = {}) {
  if (!Number.isSafeInteger(afterStep) || afterStep < 0) throw new Error("afterStep must be the step count deliver returned");
  if (!(timeoutMs >= 0) || !(pollMs > 0)) throw new Error("timeoutMs and pollMs must be positive numbers");
  const { listed, call } = await connectAntigravity(connection);
  if (typeof conversation !== "string" || !Object.hasOwn(listed, conversation)) {
    throw new Error("That id is not a conversation on the running Antigravity server");
  }
  const deadline = performance.now() + timeoutMs;
  let status = listed[conversation]?.status, ran = false;
  for (;;) {
    if (status === RUNNING) ran = true;
    if (status === IDLE) {
      const steps = await stepsOf(call, conversation);
      const text = steps.slice(afterStep).map(answerOf).filter(Boolean).at(-1);
      if (text) return { status: "replied", ...bounded(text), steps: steps.length };
      if (ran) return { status: "no-reply", steps: steps.length };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { status: "timeout" };
    await sleep(Math.min(pollMs, remaining));
    status = (await summaries(call))[conversation]?.status;
  }
}
