import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sendRawUdsFrame } from "../src/index.mjs";

const cli = fileURLToPath(new URL("../bin/consessus.mjs", import.meta.url));
const scratch = fileURLToPath(new URL("../tmp/agent-c1-tests/", import.meta.url));
fs.mkdirSync(scratch, { recursive: true });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(scratch, "run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "workspace");
  const sessions = path.join(dir, "claude", "sessions");
  fs.mkdirSync(cwd);
  const agent = path.join(home, "agents", "worker");
  const env = { ...process.env, CONSESSUS_HOME: home, CLAUDE_CONFIG_DIR: path.dirname(sessions) };
  const inbox = path.join(agent, "inbox.jsonl");
  const cursor = path.join(agent, "cursor");
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 4000, ...extra });
  const wait = (...args) => run(["wait", "--name", "worker", ...args]);
  const seed = (body) => {
    fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
    fs.appendFileSync(inbox, body, { mode: 0o600 });
  };
  return { cwd, env, home, agent, inbox, cursor, sessions, run, wait, seed };
}

function message(content) {
  return { type: "user", from: "uds:/fixture/123.sock", message: { role: "user", content } };
}

function record(seq, body) {
  return JSON.stringify({ seq, ts: "2026-01-01T00:00:00Z", frame: message(body) }) + "\n";
}

async function until(check) {
  for (let i = 0; i < 120; i++) {
    const result = check();
    if (result) return result;
    await sleep(20);
  }
  throw new Error("Timed out waiting for fixture");
}

async function listen(t, f, ...flags) {
  const child = spawn(process.execPath, [cli, "agent", "--name", "worker", ...flags], { cwd: f.cwd, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8").on("data", (line) => { output += line; });
  child.stderr.setEncoding("utf8").on("data", (line) => { error += line; });
  let socket;
  async function stop(signal = "SIGTERM") {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill(signal);
      await closed;
    }
    if (socket && signal === "SIGKILL") fs.rmSync(socket, { force: true });
  }
  t.after(async () => stop());
  socket = await until(() => {
    if (child.exitCode !== null) throw new Error(error || "Listener exited before registration");
    if (!output.includes("Listening for incoming peer messages")) return undefined;
    return output.match(/at uds:(\S+) \(PID /)?.[1];
  });
  const send = (frame) => sendRawUdsFrame(socket, child.pid, frame, { sessionsDir: f.sessions, closeDelayMs: 0 });
  const sendWithoutAuth = (frame) => sendRawUdsFrame(socket, undefined, frame, { closeDelayMs: 0 });
  return { stop, send, sendWithoutAuth, output: () => output };
}

test("room control listener requires socket authentication for inbox frames", async (t) => {
  const f = fixture(t);
  const agent = await listen(t, f, "--inbox", "--room-control");
  await agent.sendWithoutAuth(message("fixture-unauthenticated"));
  await agent.send(message("fixture-authenticated"));
  const stored = await until(() => fs.existsSync(f.inbox) && fs.readFileSync(f.inbox, "utf8"));
  assert.doesNotMatch(stored, /fixture-unauthenticated/);
  assert.match(stored, /fixture-authenticated/);
});

test("inbox mode journals non-auth frames privately, retains sequence across restarts, and does not log bodies", async (t) => {
  const f = fixture(t);
  const agent = await listen(t, f, "--inbox");
  const sent = f.run(["send", "--to", "worker", "--message", "fixture-private-body", "--from-name", "Fixture Sender", "--from-mode", "prompting"]);
  assert.equal(sent.status, 0, sent.stderr);
  await agent.send({ type: "auth", token: "fake-handshake-value" });
  await agent.send({ type: "keep_alive" });
  await agent.send({ type: "control", action: "fixture-control" });
  const lines = () => fs.existsSync(f.inbox) ? fs.readFileSync(f.inbox, "utf8").trim().split("\n").map(JSON.parse) : [];
  await until(() => lines().some(row => row.frame.type === "control"));
  assert.equal(fs.statSync(f.agent).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.inbox).mode & 0o777, 0o600);
  assert.deepEqual(lines().map(row => row.seq), [1, 2]);
  assert.deepEqual(lines().map(row => row.frame.type), ["user", "control"]);
  assert.ok(lines().every(row => Number.isFinite(Date.parse(row.ts))));
  assert.doesNotMatch(agent.output(), /fixture-private-body|fake-handshake-value|fixture-control/);
  const plain = f.wait("--timeout", "0");
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Fixture Sender/);
  assert.match(plain.stdout, /> fixture-private-body/);
  assert.match(plain.stdout, /peer data/i);
  assert.equal(fs.statSync(f.cursor).mode & 0o777, 0o600);
  await agent.stop("SIGKILL");
  f.seed('{"seq":3,"ts":"incomplete"');
  const restarted = await listen(t, f, "--inbox");
  await restarted.send(message("third-record"));
  await until(() => lines().length === 3);
  const rest = f.wait("--json", "--all", "--timeout", "0");
  assert.equal(rest.status, 0, rest.stderr);
  assert.deepEqual(rest.stdout.trim().split("\n").map(line => JSON.parse(line).seq), [2, 3]);
});

test("agent without --inbox keeps logging and does not create private inbox files", async (t) => {
  const f = fixture(t);
  const agent = await listen(t, f);
  await agent.send(message("ordinary-fixture-message"));
  await until(() => agent.output().includes("ordinary-fixture-message"));
  assert.equal(fs.existsSync(f.home), false);
});

test("wait delivers pending records once, in sequence, and times out silently when caught up", (t) => {
  const f = fixture(t);
  f.seed(record(1, "first") + record(2, "second"));
  for (const seq of [1, 2]) {
    const result = f.wait("--json", "--timeout", "0");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).seq, seq);
  }
  const exhausted = f.wait("--timeout", "0.03");
  assert.equal(exhausted.status, 2, exhausted.stderr);
  assert.equal(exhausted.stdout, "");
  assert.equal(exhausted.stderr, "");
});

test("wait blocks until append and ignores even a parseable final line without its newline", async (t) => {
  const f = fixture(t);
  const row = record(1, "finish-line");
  f.seed(row.slice(0, -1));
  const partial = f.wait("--timeout", "0.03");
  assert.equal(partial.status, 2, partial.stderr);
  assert.equal(partial.stdout, "");
  assert.equal(fs.existsSync(f.cursor), false);
  const child = spawn(process.execPath, [cli, "wait", "--name", "worker", "--json", "--timeout", "2"], { cwd: f.cwd, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", (line) => { output += line; });
  child.stderr.on("data", (line) => { error += line; });
  const ended = once(child, "close");
  try {
    await sleep(180);
    assert.equal(output, "");
    assert.equal(child.exitCode, null);
    f.seed("\n");
    const [code] = await ended;
    assert.equal(code, 0, error);
    assert.equal(JSON.parse(output).frame.message.content, "finish-line");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended;
  }
});

test("an OS write failure on stdout leaves the cursor unchanged", (t) => {
  const f = fixture(t);
  f.seed(record(1, "first") + record(2, "retry-me"));
  assert.equal(f.wait("--timeout", "0").status, 0);
  const before = fs.readFileSync(f.cursor, "utf8");
  const fd = fs.openSync(f.inbox, "r");
  try {
    const broken = f.run(["wait", "--name", "worker", "--timeout", "0"], { stdio: ["ignore", fd, "pipe"] });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /EBADF/);
    assert.equal(fs.readFileSync(f.cursor, "utf8"), before);
  } finally {
    fs.closeSync(fd);
  }
  const retried = f.wait("--json", "--timeout", "0");
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).seq, 2);
});

test("rejects another listener or waiter for the same name and recovers a dead waiter", async (t) => {
  const f = fixture(t);
  const agent = await listen(t, f, "--inbox");
  const duplicate = f.run(["agent", "--name", "worker", "--inbox"]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /writer is already active/);
  const child = spawn(process.execPath, [cli, "wait", "--name", "worker"], { cwd: f.cwd, env: f.env, stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await until(() => fs.existsSync(path.join(f.agent, "wait.lock")));
    const second = f.wait("--timeout", "0");
    assert.equal(second.status, 1);
    assert.match(second.stderr, /wait is already active/);
    child.kill("SIGKILL");
    await closed;
    assert.equal(fs.existsSync(f.cursor), false);
    await agent.send(message("waiter recovery"));
    const resumed = f.wait("--json", "--timeout", "2");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).frame.message.content, "waiter recovery");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});

test("refuses path-like inbox names and a symlink at the inbox path", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["wait", "--name", "../worker", "--timeout", "0"]).status, 1);
  fs.mkdirSync(f.agent, { recursive: true, mode: 0o700 });
  const external = path.join(f.cwd, "do-not-read");
  fs.writeFileSync(external, record(1, "outside inbox"), { mode: 0o600 });
  fs.symlinkSync(external, f.inbox);
  const result = f.wait("--timeout", "0");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(f.cursor), false);
  assert.equal(fs.readFileSync(external, "utf8"), record(1, "outside inbox"));
});

for (const [kind, mode] of [["file", 0o640], ["directory", 0o750]]) {
  test(`refuses an existing group-readable inbox ${kind}`, (t) => {
    const f = fixture(t);
    const entry = record(1, "private fixture");
    f.seed(entry);
    fs.chmodSync(kind === "file" ? f.inbox : f.agent, mode);
    const result = f.wait("--timeout", "0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be owned by this user and private/);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(f.cursor), false);
    assert.equal(fs.readFileSync(f.inbox, "utf8"), entry);
  });
}
