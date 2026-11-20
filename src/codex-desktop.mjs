import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FRAME = 1024 * 1024;

export const startCodexDesktop = (options) => requestCodexDesktop(options, "start");
export const steerCodexDesktop = (options) => requestCodexDesktop(options, "steer");
export const reconcileCodexQueueCard = (options) => requestCodexDesktop({ ...options, messageId: options.queueId }, "reconcile");

async function requestCodexDesktop({ threadId, text, messageId,
  socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "ipc", "ipc.sock") }, operation) {
  const reconcile = operation === "reconcile";
  const unavailable = (reason) => ({ status: operation === "steer" ? "queue" : "unavailable", reason });
  if ((reconcile ? [threadId, messageId] : [threadId, text, messageId]).some((value) => typeof value !== "string" || !value.trim())) {
    throw new TypeError(reconcile ? "Desktop queue reconciliation requires threadId and queueId strings" : "Desktop Steer requires threadId, text and messageId strings");
  }
  try {
    const uid = process.getuid?.();
    const dir = fs.lstatSync(path.dirname(socketPath));
    const endpoint = fs.lstatSync(socketPath);
    if (uid === undefined || !dir.isDirectory() || dir.uid !== uid || !endpoint.isSocket() || endpoint.uid !== uid) {
      return unavailable("desktop-endpoint-untrusted");
    }
  } catch {
    return unavailable("desktop-endpoint-unavailable");
  }

  const socket = new net.Socket();
  let pending, fault, closing = false, mutated = false, stage = "connect";
  let clientId = "initializing-client";
  const settle = (error, value) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    if (error) current.reject(error); else current.resolve(value);
  };
  const fail = (error) => {
    if (closing) return;
    fault ||= error;
    settle(fault);
    socket.destroy();
  };
  const encode = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME) throw new Error("Desktop IPC frame exceeds 1 MiB");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
  };
  const receive = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Malformed Desktop IPC message");
    if (message.type === "broadcast") return;
    if (message.type === "client-discovery-request") {
      if (typeof message.requestId !== "string" || !message.requestId) throw new Error("Malformed Desktop client discovery");
      socket.write(encode({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }));
      return;
    }
    if (message.type !== "response" || !pending || message.requestId !== pending.id) return;
    if ((message.method !== undefined && message.method !== pending.method) ||
      !["success", "error"].includes(message.resultType) ||
      (message.resultType === "success" && message.method !== pending.method) ||
      (message.resultType === "error" && typeof message.error !== "string")) {
      throw new Error("Malformed Desktop IPC response");
    }
    settle(null, message);
  };
  let header = Buffer.alloc(4), headerBytes = 0, body, bodyBytes = 0;
  socket.on("data", (chunk) => {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!body) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count; offset += count;
          if (headerBytes < 4) continue;
          const length = header.readUInt32LE();
          if (!length || length > MAX_FRAME) throw new Error("Invalid Desktop IPC frame length");
          body = Buffer.allocUnsafe(length); bodyBytes = 0;
        }
        const count = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + count);
        bodyBytes += count; offset += count;
        if (bodyBytes === body.length) {
          const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
          body = undefined; headerBytes = 0;
          receive(message);
        }
      }
    } catch (error) { fail(error); }
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Desktop IPC connection closed")));

  const request = (method, version, params, extra = {}) => {
    if (fault || !socket.writable) return Promise.reject(fault || new Error("Desktop IPC not connected"));
    const timeoutMs = method === "thread-follower-steer-turn" ? 45000 : 12000;
    const id = randomUUID();
    const bytes = encode({ type: "request", requestId: id, sourceClientId: clientId, version, method, params, timeoutMs, ...extra });
    return new Promise((resolve, reject) => {
      pending = { id, method, resolve, reject, timer: setTimeout(() => fail(new Error(`Desktop IPC ${method} timeout`)), timeoutMs) };
      // A write attempt is uncertain until the native handler positively answers.
      if (["thread-follower-steer-turn", "thread-follower-start-turn", "thread-follower-remove-queued-message"].includes(method)) mutated = true;
      try { socket.write(bytes); } catch (error) { fail(error); }
    });
  };
  try {
    await new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => fail(new Error("Desktop IPC connect timeout")), 12000) };
      socket.once("connect", () => settle(null));
      socket.connect(socketPath);
    });
    stage = "initialize";
    const initialized = await request("initialize", 0, { clientType: "claude-peer" });
    if (initialized.resultType !== "success" || typeof initialized.result?.clientId !== "string" || !initialized.result.clientId.trim()) {
      return unavailable("desktop-initialize-rejected");
    }
    clientId = initialized.result.clientId;
    stage = "owner-discovery";
    const owner = await request("thread-owner-discovery", 1, { hostId: "local", conversationId: threadId });
    if (owner.resultType !== "success" || owner.result?.supportsUntrustedAppInput !== true ||
      typeof owner.handledByClientId !== "string" || !owner.handledByClientId.trim()) {
      return unavailable("desktop-owner-unavailable");
    }
    if (operation === "start") {
      stage = "start";
      const response = await request("thread-follower-start-turn", 3, {
        conversationId: threadId,
        turnStart: {
          request: { threadId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: messageId },
          context: { restoreMessage: { id: messageId, text, context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null,
            imageAttachments: [], workspaceRoots: [] } } },
        },
      }, { hostId: "local", targetClientId: owner.handledByClientId });
      if (response.resultType === "error") {
        if (["no-client-found", "request-version-mismatch", "no-handler-for-request"].includes(response.error)) return unavailable(response.error);
        throw new Error(`Desktop start rejected after handoff: ${response.error.slice(0, 300)}`);
      }
      const turnId = response.result?.result?.turn?.id;
      if (response.handledByClientId !== owner.handledByClientId || typeof turnId !== "string" || !turnId.trim()) throw new Error("Malformed Desktop start acceptance");
      return { status: "started", turnId };
    }
    stage = reconcile ? "queue-reconcile" : "steer";
    if (reconcile) {
      const response = await request("thread-follower-remove-queued-message", 2,
        { conversationId: threadId, messageId }, { hostId: "local", targetClientId: owner.handledByClientId });
      if (response.resultType === "error") {
        if (["no-client-found", "request-version-mismatch", "no-handler-for-request"].includes(response.error)) return unavailable(response.error);
        throw new Error(`Desktop queue reconciliation rejected: ${response.error.slice(0, 300)}`);
      }
      if (response.handledByClientId !== owner.handledByClientId || !response.result || !Object.hasOwn(response.result, "removed") ||
        (response.result.removed !== null && (typeof response.result.removed !== "object" || Array.isArray(response.result.removed)))) {
        throw new Error("Malformed Desktop queue reconciliation acceptance");
      }
      return { status: "reconciled" };
    }
    const response = await request("thread-follower-steer-turn", 2, {
      conversationId: threadId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: messageId,
      restoreMessage: { id: messageId, text, context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null,
        imageAttachments: [], workspaceRoots: [] } }, attachments: [], serviceTier: null,
    }, { hostId: "local", targetClientId: owner.handledByClientId });
    if (response.resultType === "error") {
      const error = response.error;
      if (["no-client-found", "request-version-mismatch", "no-handler-for-request"].includes(error)) return unavailable(error);
      if (error === `Conversation ${threadId} is not being streamed.` ||
        error === `Cannot steer conversation ${threadId} because its active turn already ended`) {
        return unavailable("no-active-turn");
      }
      throw new Error(`Desktop Steer rejected after handoff: ${error.slice(0, 300)}`);
    }
    const turnId = response.result?.result?.turnId;
    if (response.handledByClientId !== owner.handledByClientId || typeof turnId !== "string" || !turnId.trim()) {
      throw new Error("Malformed Desktop Steer acceptance");
    }
    return { status: "steered", turnId };
  } catch (error) {
    if (mutated) throw error;
    return unavailable(`desktop-${stage}-unavailable`);
  } finally {
    closing = true;
    clearTimeout(pending?.timer);
    socket.destroy();
  }
}
