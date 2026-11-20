import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProcStart, startPeerAgentDaemon } from "../src/index.mjs";
import { canonicalProject, createRoomIdentity, projectContains } from "../src/room-identity.mjs";

const scratch = fileURLToPath(new URL("../tmp/agent-c2-identity/", import.meta.url));
const start = "Thu Nov 19 12:34:56 2026";
const later = "Thu Nov 19 12:34:57 2026";
const signatures = {
  native: ["com.anthropic.claude-code", "Q6L2SF6YDW"],
  codex: ["com.openai.codex", "2DC432GLL2"],
  antigravity: ["language_server", "EQHXZ8M8AV", "/Applications/Antigravity.app/Contents/Resources/bin/language_server"],
  opencode: ["opencode", "5NZ4Q7NXJ4"],
};

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(scratch, "t-"));
  const project = path.join(dir, "work"), sibling = path.join(dir, "workspace");
  const cwd = path.join(project, "src"), alias = path.join(dir, "alias");
  const sessionsDir = path.join(dir, "reg");
  for (const folder of [cwd, sibling, sessionsDir]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.symlinkSync(project, alias, "dir");
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true });
  });
  const processes = new Map();
  const sockets = new Map();
  const uid = process.getuid();
  const callerPid = 901;
  const addProcess = (pid, overrides = {}) => {
    const details = { ppid: 1, uid, cwd, started: start, ...overrides };
    processes.set(pid, details);
    return details;
  };
  addProcess(callerPid);
  const way = (pid, fields) => `p${pid}\0\n${fields.map(set => `${set.join("\0")}\0\n`).join("")}`;
  const run = async (command, args) => {
    if (command === "/bin/ps") {
      return { stdout: [...processes].map(([pid, p]) => `${pid} ${p.ppid} ${p.uid} ${p.started} ${p.argv ?? "/bin/sh"}\n`).join("") };
    }
    if (command === "/usr/sbin/lsof" && args.includes("-U")) {
      return { stdout: [...sockets].flatMap(([filename, holders]) => holders.map(pid => way(pid, [["f5", "tunix", `n${filename}`]]))).join("") };
    }
    if (command === "/usr/sbin/lsof") {
      return { stdout: args[args.indexOf("-p") + 1].split(",").flatMap(pid => {
        const p = processes.get(Number(pid));
        return p?.cwd ? [way(pid, [["fcwd", "tDIR", `n${p.cwd}`]])] : [];
      }).join("") };
    }
    const p = processes.get(Number(args.at(-1)));
    const sig = signatures[p?.signature] ?? p?.signature;
    if (command === "/usr/bin/codesign" && args.includes("-d")) {
      return sig ? { stderr: `Executable=${sig[2] ?? "/signed/app"}\nIdentifier=${sig[0]}\nTeamIdentifier=${sig[1]}\n` } : null;
    }
    if (command === "/usr/bin/codesign" && args.includes("--verify")) {
      return sig && p.verified !== false && args.some(arg => arg.includes(`"${sig[0]}"`) && arg.includes(`"${sig[1]}"`)) ? {} : null;
    }
    assert.fail(`Unexpected command ${command}`);
  };
  const identity = createRoomIdentity({ sessionsDir, callerPid, run });
  async function peer(pid, processFields = {}, registryFields = {}) {
    addProcess(pid, processFields);
    const socket = path.join(dir, `${pid}.s`);
    const server = net.createServer(conn => conn.end());
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    servers.push(server);
    fs.chmodSync(socket, 0o600);
    sockets.set(socket, [pid]);
    const file = path.join(sessionsDir, `${pid}.json`);
    const row = { pid, sessionId: `session-${pid}`, cwd: processes.get(pid).cwd, procStart: start,
      messagingSocketPath: socket, ...registryFields };
    fs.writeFileSync(file, JSON.stringify(row), { mode: 0o644 });
    return { address: `uds:${socket}`, sessionId: row.sessionId, pid, file, socket, row };
  }
  return { identity, dir, project, sibling, cwd, alias, sessionsDir, processes, sockets, callerPid, addProcess, peer };
}

test("canonical projects resolve symlinks and enforce directory boundaries", t => {
  const f = fixture(t);
  assert.equal(canonicalProject(f.alias), f.project);
  assert.equal(projectContains(f.project, path.join(f.alias, "src")), true);
  assert.equal(projectContains(f.project, f.sibling), false);
  assert.equal(projectContains(f.project, path.join(f.project, "missing")), false);
  assert.throws(() => canonicalProject(""));
});

test("discovery selects scoped live native Claude peers and ignores registry claims", async t => {
  const f = fixture(t);
  const keep = await f.peer(101, { signature: "native" }, { cwd: path.join(f.alias, "src") });
  await f.peer(102, { signature: "native", cwd: f.sibling });
  await f.peer(103, { signature: "native", cwd: f.sibling }, { cwd: f.cwd });
  await f.peer(104, { ppid: 101 }, { entrypoint: "claude-desktop" });
  await f.peer(105, { signature: "codex" }, { kind: "claude", entrypoint: "claude-desktop" });
  const result = await f.identity.discover(f.alias);
  assert.deepEqual(result.map(row => [row.pid, row.cwd, row.id]), [[keep.pid, f.cwd, `claude:${keep.sessionId}`]]);
});

test("an unknown process tree is refused even if argv and registry claim to be a known app", async t => {
  const f = fixture(t);
  const unknown = await f.peer(101, { argv: "/bin/sh fake /Applications/Claude.app/Contents/MacOS/Claude" }, { kind: "claude" });
  await assert.rejects(f.identity.attest(f.project, unknown), /process tree|signature/i);
  assert.equal(await f.identity.isAgentCaller(), false);
});

test("unavailable caller process evidence cannot certify an operator terminal", async t => {
  const f = fixture(t);
  f.processes.delete(f.callerPid);
  await assert.rejects(f.identity.isAgentCaller(), /caller process tree.*unavailable/i);
});

test("the endpoint requires the live PID generation, socket owner and exact registry record", async t => {
  const f = fixture(t);
  const known = await f.peer(101, { signature: "native" });
  const id = await f.identity.attest(f.project, known);
  assert.equal(id.address, known.address);
  assert.equal(id.sessionId, known.sessionId);
  assert.equal(await f.identity.isLive(id), true);
  const aliased = path.join(f.dir, "socket-alias");
  fs.symlinkSync(known.socket, aliased);
  assert.equal(await f.identity.isLive({ ...id, address: `uds:${aliased}`, cwd: path.join(f.alias, "src") }), false);
  await assert.rejects(f.identity.attest(f.project, { ...known, sessionId: "claimed" }));
  f.sockets.set(known.socket, [known.pid, 222]);
  assert.equal(await f.identity.isLive(id), false);
  await assert.rejects(f.identity.attest(f.project, known));
  f.sockets.set(known.socket, [known.pid]);
  f.processes.get(known.pid).started = later;
  assert.equal(await f.identity.isLive(id), false);
  await assert.rejects(f.identity.attest(f.project, known));
  f.processes.get(known.pid).started = start;
  fs.chmodSync(known.file, 0o666);
  assert.equal(await f.identity.isLive(id), false);
});

test("an altered signing team or invalid dynamic signature is refused", async t => {
  const f = fixture(t);
  const wrong = await f.peer(101, { signature: [signatures.native[0], "OTHERTEAM"] });
  const invalid = await f.peer(102, { signature: "native", verified: false });
  const otherGoogleCli = await f.peer(103, { signature: ["cli", "EQHXZ8M8AV", "/applications/other-app/cli"] });
  await assert.rejects(f.identity.attest(f.project, wrong), /process tree|signature/i);
  await assert.rejects(f.identity.attest(f.project, invalid), /process tree|signature/i);
  await assert.rejects(f.identity.attest(f.project, otherGoogleCli), /process tree|signature/i);
});

test("a sibling bridge may request a join but cannot act as the registered endpoint", async t => {
  const f = fixture(t);
  f.addProcess(110, { signature: "antigravity" });
  f.addProcess(111, { signature: "antigravity" });
  const bridge = await f.peer(101, { ppid: 110 }, { bridgeSessionId: "unverified-conversation" });
  f.processes.get(f.callerPid).ppid = 110;
  assert.equal(await f.identity.isAgentCaller(), true);
  await assert.rejects(f.identity.caller(f.project), /caller|ancestor|ancestry/i);
  await assert.rejects(f.identity.caller(f.project, bridge), /process tree/i);
  const identity = await f.identity.caller(f.project, { ...bridge, allowSharedHost: true });
  assert.equal(identity.anchorPid, 110);
  assert.equal(identity.id, `antigravity:${bridge.sessionId}`);
  await assert.rejects(f.identity.caller(f.project, { address: bridge.address }));
  f.processes.get(f.callerPid).cwd = f.sibling;
  await assert.rejects(f.identity.caller(f.project, { ...bridge, allowSharedHost: true }));
  f.processes.get(f.callerPid).cwd = f.cwd;
  f.processes.get(f.callerPid).ppid = 111;
  await assert.rejects(f.identity.caller(f.project, { ...bridge, allowSharedHost: true }));
  f.processes.get(f.callerPid).ppid = 101;
  assert.equal((await f.identity.caller(f.project)).id, identity.id);
});

test("implicit caller fails if more than one registered endpoint appears in its ancestry", async t => {
  const f = fixture(t);
  const native = await f.peer(101, { signature: "native" });
  const bridge = await f.peer(102, { ppid: native.pid });
  f.processes.get(f.callerPid).ppid = bridge.pid;
  await assert.rejects(f.identity.caller(f.project), /ambiguous|multiple/i);
  assert.equal((await f.identity.caller(f.project, native)).pid, native.pid);
});

test("a live controller is checked without treating it as an app participant", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t);
  const project = canonicalProject(process.cwd());
  const daemon = await startPeerAgentDaemon({ sessionsDir: f.sessionsDir, sockDir: f.dir });
  t.after(daemon.cleanup);
  const identity = createRoomIdentity({ sessionsDir: f.sessionsDir });
  const controller = { ...daemon, kind: "controller", cwd: project, procStart: getProcStart(daemon.pid) };
  assert.equal(await identity.isLive(controller), true);
  assert.equal(await identity.isLive({ ...controller, procStart: later }), false);
  assert.equal(await identity.isLive({ ...controller, cwd: f.cwd }), false);
  daemon.cleanup();
  assert.equal(await identity.isLive(controller), false);
});

test("when the process list or the open-file list cannot be read, liveness is unknown, not false", async t => {
  const f = fixture(t);
  const peer = await f.peer(120, { signature: "native" });
  const member = await f.identity.attest(f.project, peer);
  assert.equal(await f.identity.isLive(member), true);
  for (const broken of ["/bin/ps", "/usr/sbin/lsof"]) {
    const identity = createRoomIdentity({ sessionsDir: f.sessionsDir, callerPid: f.callerPid, run: async command => command === broken ? null : { stdout: "" } });
    await assert.rejects(identity.isLive(member), /could not be (read|listed)/);
  }
});
