import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatPeerData, peerSenderClaim } from "./agent-inbox.mjs";
import { isPidAlive } from "./index.mjs";
import { SESSION_ID, loopback, readOpencodeReply } from "./opencode-replies.mjs";

const exec = promisify(execFile);

// OpenCode gives its own tool processes the server credentials. The listener is one of
// them, so it posts with what it was handed and never reads another process's secrets.
function authHeader(env) {
  const user = env.OPENCODE_SERVER_USERNAME, password = env.OPENCODE_SERVER_PASSWORD;
  return user && password ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } : {};
}

export const opencodeRegistration = (env = process.env) =>
  path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode", "service.json");

// The OpenCode 2.x background service writes its url and password to an owner-only file for
// its own clients; its tool shells do not get the password. That file is the sanctioned source.
export function readOpencodeService({ registration = opencodeRegistration(), isAlive = isPidAlive, uid = process.getuid() } = {}) {
  let service, fd;
  try {
    fd = fs.openSync(registration, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error("not private");
    service = JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch { service = undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (typeof service?.password !== "string" || !service.password || !Number.isSafeInteger(service.pid) || service.pid <= 1) {
    throw new Error("no usable OpenCode service registration file");
  }
  const origin = loopback(service.url);
  if (!isAlive(service.pid)) throw new Error("OpenCode service is not running");
  return { origin, headers: { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` } };
}

async function ancestorPorts() {
  const ports = new Set();
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    try {
      const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
      for (const match of stdout.matchAll(/^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/gm)) ports.add(Number(match[1]));
    } catch {}
    try {
      const { stdout } = await exec("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
      pid = Number(stdout.trim());
    } catch { break; }
  }
  return [...ports];
}

export async function openOpencodeDelivery({ server, session = "auto", cwd = process.cwd(), env = process.env,
  delivery, listPorts = ancestorPorts, request = fetch, registration = opencodeRegistration(env), isAlive, uid } = {}) {
  let headers = authHeader(env);
  if (session === "auto" && env.OPENCODE_SESSION_ID) session = env.OPENCODE_SESSION_ID;
  if (session !== "auto" && !SESSION_ID.test(session)) throw new Error("Invalid OpenCode session id");
  if (delivery !== undefined && !["steer", "queue"].includes(delivery)) throw new Error("OpenCode delivery must be steer or queue");
  const directory = fs.realpathSync.native(cwd);
  const list = async origin => {
    const reply = await request(`${origin}/api/session?directory=${encodeURIComponent(directory)}&limit=2`,
      { headers, signal: AbortSignal.timeout(3000) });
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    const sessions = (await reply.json())?.data;
    if (!Array.isArray(sessions)) throw new Error("Unexpected session list");
    return sessions;
  };

  let origin, sessions;
  if (server !== undefined) {
    origin = loopback(server);
  } else {
    for (const port of await listPorts()) {
      const candidate = `http://127.0.0.1:${port}`;
      try { sessions = await list(candidate); origin = candidate; break; } catch {}
    }
    if (!origin) {
      try { ({ origin, headers } = readOpencodeService({ registration, isAlive, uid })); }
      catch (error) {
        throw new Error(`No OpenCode server answered on this listener's parent processes (and ${error.message}). Pass --opencode-server`);
      }
    }
  }
  if (session === "auto") {
    sessions ??= await list(origin);
    const ids = sessions.map(row => row?.id).filter(id => typeof id === "string" && SESSION_ID.test(id));
    if (ids.length !== 1) throw new Error("Expected exactly one OpenCode session for this project. Pass --opencode-session <id>");
    session = ids[0];
  }

  // Two servers exist and document themselves differently. The CLI background service (2.x) takes
  // { text } on /api/session/<id>/prompt and, newer, a labelled notice on .../synthetic. The desktop
  // app documents /prompt too, but it fails there (measured on 1.19.5), and its own client uses
  // /session/<id>/prompt_async with text parts. No body ever carries `tools`: it rewrites permission rules.
  const documented = async route => {
    try {
      const reply = await request(`${origin}${route}`, { headers, signal: AbortSignal.timeout(3000) });
      return reply.ok ? (await reply.json())?.paths ?? {} : {};
    } catch { return {}; }
  };
  const posts = (paths, pattern) => Object.entries(paths).some(([key, item]) => pattern.test(key) && item?.post);
  const choice = delivery === undefined ? {} : { delivery };
  const api = await documented("/openapi.json");
  let target;
  if (posts(api, /^\/api\/session\/\{[^}]+\}\/synthetic$/)) {
    target = { marks: true, path: `/api/session/${session}/synthetic`, body: frame => ({ text: formatPeerData(frame),
      description: `Message from ${peerSenderClaim(frame)} via Consessus`, metadata: { source: "consessus" }, ...choice }) };
  } else if (posts(api, /^\/api\/session\/\{[^}]+\}\/prompt$/)) {
    target = { marks: true, path: `/api/session/${session}/prompt`, body: frame => ({ text: formatPeerData(frame), ...choice }) };
  } else if (posts(await documented("/doc"), /^\/session\/\{[^}]+\}\/prompt_async$/)) {
    target = { path: `/session/${session}/prompt_async`, body: frame => ({ parts: [{ type: "text", text: formatPeerData(frame) }] }) };
  } else {
    throw new Error("This OpenCode server does not document a message endpoint this version knows");
  }

  return {
    server: origin,
    session,
    // The CLI service answers a prompt with the message it admitted; that id is the marker readReply reads
    // after. No marker unless the session was seen idle or running just before: unknown is not idle.
    async deliver(frame) {
      if (!["user", "message"].includes(frame?.type)) return { status: "skipped" };
      let busy;
      if (target.marks) {
        try {
          const reply = await request(`${origin}/api/session/active`, { headers, signal: AbortSignal.timeout(3000) });
          const active = reply.ok ? (await reply.json())?.data : undefined;
          if (active && typeof active === "object") busy = Object.hasOwn(active, session);
        } catch {}
      }
      try {
        const reply = await request(`${origin}${target.path}`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(target.body(frame)), signal: AbortSignal.timeout(10000),
        });
        if (!reply.ok) return { status: "failed", session, reason: `HTTP ${reply.status}` };
        let after;
        if (busy !== undefined) try { after = (await reply.json())?.data?.id; } catch {}
        return { status: "delivered", session, ...(typeof after === "string" && /^msg_[A-Za-z0-9]+$/.test(after) ? { busy, after } : {}) };
      } catch (error) {
        return { status: "failed", session, reason: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
      }
    },
    // The address and credentials stay inside this closure; callers pass only the marker and the waits.
    readReply: ({ after, timeoutMs, pollMs } = {}) => readOpencodeReply({ session, after, server: origin, headers, request,
      ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(pollMs === undefined ? {} : { pollMs }) }),
  };
}
