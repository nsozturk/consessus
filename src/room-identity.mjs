import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SESSIONS_DIR, probeSocket } from "./index.mjs";

const exec = promisify(execFile);
const START = "[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4}";
const PS_ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${START})(?:\\s|$)`);
const START_TIME = new RegExp(`^${START}$`);
const PID_FILE = /^([1-9]\d*)\.json$/;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPS = [
  { kind: "claude", label: "Claude Code", team: "Q6L2SF6YDW", id: /^com\.anthropic\.claude-code$/, native: true },
  { kind: "claude", label: "Claude Desktop", team: "Q6L2SF6YDW", id: /^com\.anthropic\.claudefordesktop$/, native: true },
  { kind: "claude", label: "Claude Desktop helper", team: "Q6L2SF6YDW", id: /^com\.anthropic\.claudefordesktop\.helper(?:\.[a-z]+)?$/ },
  { kind: "codex", label: "Codex", team: "2DC432GLL2", id: /^(?:codex|com\.openai\.codex(?:\.helper(?:\.[a-z]+)?)?)$/ },
  { kind: "antigravity", label: "Antigravity", team: "EQHXZ8M8AV", id: /^com\.google\.antigravity(?:-ide)?(?:\.helper(?:\.[a-z]+)?)?$/ },
  { kind: "antigravity", label: "Antigravity", team: "EQHXZ8M8AV", id: /^language_server$/, path: /\/Antigravity(?: IDE)?\.app\/Contents\/Resources\/bin\/language_server$/ },
  { kind: "antigravity", label: "Antigravity CLI", team: "EQHXZ8M8AV", id: /^cli$/, path: /\/agy$/ },
  { kind: "opencode", label: "OpenCode", team: "5NZ4Q7NXJ4", id: /^(?:opencode|ai\.opencode\.desktop(?:\.helper(?:\.[a-z]+)?)?)$/ },
];

export function canonicalProject(input) {
  if (typeof input !== "string" || !input.trim()) throw new TypeError("A project directory is required");
  const canonical = fs.realpathSync.native(input);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("Project path must be a directory");
  return canonical;
}

function contains(project, cwd) {
  const relative = path.relative(project, cwd);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function projectContains(project, cwd) {
  try { return contains(canonicalProject(project), canonicalProject(cwd)); }
  catch { return false; }
}

const validPid = pid => Number.isSafeInteger(pid) && pid > 1;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const validSessionId = value => typeof value === "string" && sessionIdPattern.test(value);
const validStart = value => typeof value === "string" && START_TIME.test(value);

function realPath(filename) {
  if (!absolute(filename)) return null;
  try { return fs.realpathSync.native(filename); }
  catch { return null; }
}

const addressPath = address => typeof address === "string" && address.startsWith("uds:") ? realPath(address.slice(4)) : null;

function directory(filename) {
  if (!absolute(filename)) return null;
  try { return canonicalProject(filename); }
  catch { return null; }
}

function socketInfo(filename, uid) {
  const canonical = realPath(filename);
  if (!canonical) return null;
  try {
    const stat = fs.lstatSync(canonical, { bigint: true });
    if (stat.isSocket() && stat.uid === BigInt(uid) && (stat.mode & 0o022n) === 0n) {
      return { filename: canonical, dev: stat.dev, ino: stat.ino };
    }
  } catch {}
  return null;
}

function registryRecord(sessionsDir, pid, uid) {
  if (!validPid(pid)) return null;
  let fd;
  try {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fd = fs.openSync(path.join(sessionsDir, `${pid}.json`), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0 || stat.size > 65536) return null;
    const row = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (row?.pid !== pid || !validSessionId(row.sessionId) || !validStart(row.procStart)) return null;
    const cwd = directory(row.cwd), socket = socketInfo(row.messagingSocketPath, uid);
    return cwd && socket ? { pid, sessionId: row.sessionId, procStart: row.procStart, cwd, socket } : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readRegistry(sessionsDir, uid) {
  let names;
  try { names = fs.readdirSync(sessionsDir); }
  catch (err) { if (err.code === "ENOENT") return []; throw err; }
  return names.map(name => registryRecord(sessionsDir, Number(PID_FILE.exec(name)?.[1]), uid)).filter(Boolean);
}

async function runMac(command, args) {
  if (process.platform !== "darwin") return null;
  try {
    return await exec(command, args, { cwd: "/", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  } catch { return null; }
}

function files(output = "") {
  const result = [];
  let pid;
  for (const record of output.split("\0\n")) {
    const [first, ...fields] = record.split("\0");
    if (first.startsWith("p")) pid = Number(first.slice(1));
    if (!validPid(pid) || !first.startsWith("f")) continue;
    const type = fields.find(field => field.startsWith("t"))?.slice(1);
    const name = fields.find(field => field.startsWith("n"))?.slice(1);
    if (type && name) result.push({ pid, fd: first.slice(1), type, name });
  }
  return result;
}

function startMatches(expected, utc) {
  // Native Claude Desktop records UTC and the public listener writes local ps time.
  return validStart(expected) && validStart(utc) && (expected === utc || Date.parse(expected) === Date.parse(`${utc} UTC`));
}

function* ancestors(processes, pid) {
  const seen = new Set();
  for (let current = processes.get(pid); current && !seen.has(current.pid); current = processes.get(current.ppid)) {
    seen.add(current.pid);
    yield current;
  }
}

export function createRoomIdentity({ sessionsDir = SESSIONS_DIR, callerPid = process.pid, run = runMac, probe = probeSocket } = {}) {
  const uid = process.getuid?.();

  async function readProcesses() {
    const output = await run("/bin/ps", ["-axww", "-o", "pid=", "-o", "ppid=", "-o", "uid=", "-o", "lstart="]);
    // A probe that did not run (a timeout on a busy machine) says nothing about who is alive.
    if (!output) throw new Error("The process list could not be read");
    const processes = new Map();
    for (const line of (output.stdout ?? "").split("\n")) {
      const match = PS_ROW.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (validPid(pid) && Number(match[3]) === uid) processes.set(pid, { pid, ppid: Number(match[2]), procStart: match[4] });
    }
    return processes;
  }

  async function signedApp(pid) {
    const display = await run("/usr/bin/codesign", ["-d", "--verbose=4", String(pid)]);
    const identifier = /^Identifier=(.+)$/m.exec(display?.stderr ?? "")?.[1];
    const team = /^TeamIdentifier=(.+)$/m.exec(display?.stderr ?? "")?.[1];
    const executable = /^Executable=(\/.+)$/m.exec(display?.stderr ?? "")?.[1];
    const app = APPS.find(candidate => candidate.team === team && candidate.id.test(identifier ?? "")
      && (!candidate.path || candidate.path.test(executable ?? "")));
    if (!app) return null;
    const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${team}" and identifier "${identifier}"`;
    return await run("/usr/bin/codesign", ["--verify", `-R=${requirement}`, String(pid)]) ? app : null;
  }

  async function host(processes, pid, appForPid, nativeOnly = false) {
    for (const current of ancestors(processes, pid)) {
      const app = await appForPid(current.pid);
      if (app && (!nativeOnly || app.native)) return { app, pid: current.pid };
      if (nativeOnly) break;
    }
    return null;
  }

  async function inspect(rows, extraPid) {
    const pids = new Set(rows.map(row => row.pid));
    if (validPid(extraPid)) pids.add(extraPid);
    const [processes, dirs, sockets] = await Promise.all([
      readProcesses(),
      run("/usr/sbin/lsof", ["-nP", "-a", "-p", [...pids].join(","), "-d", "cwd", "-F0pftn"]),
      run("/usr/sbin/lsof", ["-nP", "-a", "-u", String(uid), "-U", "-F0pftn"]),
    ]);
    if (!dirs || !sockets) throw new Error("Open files could not be listed");
    const cwd = new Map(files(dirs?.stdout).filter(row => row.fd === "cwd" && row.type === "DIR")
      .map(row => [row.pid, directory(row.name)]));
    const owners = new Map(rows.map(row => [row.socket.filename, new Set()]));
    for (const file of files(sockets?.stdout)) {
      if (file.type === "unix") owners.get(realPath(file.name))?.add(file.pid);
    }
    const signed = new Map();
    function appForPid(pid) {
      if (!signed.has(pid)) signed.set(pid, signedApp(pid));
      return signed.get(pid);
    }
    return { processes, cwd, owners, appForPid };
  }

  function endpoint(row, context) {
    const live = context.processes.get(row.pid);
    const owners = context.owners.get(row.socket.filename);
    if (live && startMatches(row.procStart, live.procStart) && context.cwd.get(row.pid) === row.cwd
      && owners?.size === 1 && owners.has(row.pid)) return live;
    return null;
  }

  async function reachable(row) {
    if (!await probe(row.socket.filename)) return false;
    const current = socketInfo(row.socket.filename, uid);
    return current?.dev === row.socket.dev && current?.ino === row.socket.ino;
  }

  async function attestRow(row, context, nativeOnly = false) {
    const live = endpoint(row, context);
    if (!live) throw new Error("Room endpoint does not match its live registry, socket owner or project directory");
    const anchor = await host(context.processes, row.pid, context.appForPid, nativeOnly);
    if (!anchor) throw new Error("Room endpoint has an unknown application signature or process tree");
    if (!await reachable(row)) throw new Error("Room endpoint socket is unavailable");
    const { app } = anchor;
    return {
      id: `${app.kind}:${row.sessionId}`,
      kind: app.kind,
      address: `uds:${row.socket.filename}`,
      sessionId: row.sessionId,
      pid: row.pid,
      cwd: row.cwd,
      procStart: live.procStart,
      evidence: `Signed ${app.label} PID ${anchor.pid}; registered Unix socket owner PID ${row.pid}`,
      anchorPid: anchor.pid,
    };
  }

  function scoped(project) {
    return readRegistry(sessionsDir, uid).filter(row => contains(project, row.cwd));
  }

  function exact(rows, { address, sessionId }) {
    const filename = addressPath(address);
    if (!filename || !validSessionId(sessionId)) throw new Error("A registered room address and full session ID are required");
    const matches = rows.filter(row => row.socket.filename === filename && row.sessionId === sessionId);
    if (matches.length !== 1) throw new Error("Room address and session ID do not identify one registered endpoint in this project");
    return matches[0];
  }

  return {
    async discover(project) {
      const rows = scoped(canonicalProject(project));
      if (!rows.length) return [];
      const context = await inspect(rows);
      const results = await Promise.allSettled(rows.map(row => attestRow(row, context, true)));
      return results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    },
    async attest(project, tuple) {
      const row = exact(scoped(canonicalProject(project)), tuple ?? {});
      return attestRow(row, await inspect([row]));
    },
    async caller(project, { address, sessionId, allowSharedHost = false } = {}) {
      const root = canonicalProject(project);
      const explicit = address !== undefined || sessionId !== undefined;
      const candidates = scoped(root);
      const rows = explicit ? [exact(candidates, { address, sessionId })] : candidates;
      const context = await inspect(rows, callerPid);
      const callerCwd = context.cwd.get(callerPid);
      if (!callerCwd || !contains(root, callerCwd)) throw new Error("Room caller is outside the project or its cwd is unavailable");
      const lineage = new Set([...ancestors(context.processes, callerPid)].map(p => p.pid));
      if (explicit) {
        const member = await attestRow(rows[0], context);
        if (lineage.has(member.pid)) return member;
        // A shared host may submit an invitation request to the verified listener.
        // It cannot prove which conversation is authorized to act as an enrolled member.
        if (allowSharedHost) {
          const callerHost = await host(context.processes, callerPid, context.appForPid);
          if (member.pid !== member.anchorPid && callerHost?.pid === member.anchorPid) return member;
        }
        throw new Error("Room caller is outside the registered endpoint's application process tree");
      }
      const results = await Promise.allSettled(rows.filter(row => lineage.has(row.pid)).map(row => attestRow(row, context)));
      const matches = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (matches.length > 1) throw new Error("Room caller has multiple registered endpoints in its ancestry; specify its address and session ID");
      if (!matches.length) throw new Error("Room caller has no verified registered endpoint in its ancestry");
      return matches[0];
    },
    async isAgentCaller() {
      const processes = await readProcesses();
      if (!processes.has(callerPid)) throw new Error("Room caller process tree is unavailable");
      return Boolean(await host(processes, callerPid, signedApp));
    },
    async isLive(member) {
      const row = registryRecord(sessionsDir, member?.pid, uid);
      if (!row || row.sessionId !== member.sessionId || row.cwd !== member.cwd
        || `uds:${row.socket.filename}` !== member.address) return false;
      const live = endpoint(row, await inspect([row]));
      return Boolean(live && startMatches(member.procStart, live.procStart) && await reachable(row));
    },
  };
}
