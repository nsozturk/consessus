import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as peer from "../src/index.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "bin/consessus.mjs");

async function fakeTarget(t, receiptStatus) {
  const scratchRoot = path.join(root, "tmp/agent-peer-public-sync");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchRoot, "p-"));
  const fixture = {
    socketPath: path.join(dir, "target.sock"),
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, "config") },
    frames: [],
    child: null,
  };
  const connections = new Set();
  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf("\n")) !== -1) {
        const frame = JSON.parse(buf.slice(0, end));
        buf = buf.slice(end + 1);
        fixture.frames.push(frame);
        if (frame.type !== "user" || !receiptStatus) continue;
        const reply = net.createConnection(frame.from.slice(4));
        reply.on("error", () => {});
        reply.on("connect", () => reply.end(JSON.stringify({
          type: "control",
          action: "peer_message_status",
          orig_msg_id: frame.msg_id,
          status: receiptStatus,
          reason: receiptStatus === "held" ? "permission-mode parity" : undefined,
        }) + "\n"));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixture.socketPath, resolve);
  });
  t.after(async () => {
    if (fixture.child && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      const stopped = new Promise((resolve) => fixture.child.once("exit", resolve));
      fixture.child.kill("SIGTERM");
      await stopped;
    }
    for (const conn of connections) conn.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (fixture.logPath) fs.rmSync(fixture.logPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fixture;
}

test("send rejects explicit invalid sender approval mode before writing", async (t) => {
  const f = await fakeTarget(t);
  for (const fromMode of ["auto", "danger-full-access", true]) {
    await assert.rejects(peer.sendMessageToSession({
      target: { pid: 0, messagingSocketPath: f.socketPath },
      message: "test only",
      fromMode,
    }), /sender|from-mode/i);
  }
  assert.equal(f.frames.length, 0);
});

test("declared sender mode and XML-escaped identity are preserved", () => {
  for (const fromMode of ["prompting", "bypass"]) {
    const content = peer.formatCrossSessionEnvelope({ text: "hello", fromName: 'A"&', fromMode });
    assert.match(content, new RegExp(`from-mode="${fromMode}"`));
    assert.match(content, /from-name="A&quot;&amp;"/);
  }
});

test("a successful socket write without a receipt remains unconfirmed", async (t) => {
  const f = await fakeTarget(t);
  const result = await peer.sendMessageToSession({
    target: { pid: 0, messagingSocketPath: f.socketPath },
    message: "test only",
    fromMode: "prompting",
  });
  assert.equal(result.receipt, "unconfirmed");
  assert.equal(f.frames.length, 1);
  assert.match(f.frames[0].message.content, /from-mode="prompting"/);
});

test("legacy omitted sender mode preserves the public v1 header and raw behavior", async (t) => {
  const f = await fakeTarget(t);
  const first = await peer.sendMessageToSession({ target: { pid: 0, messagingSocketPath: f.socketPath }, message: "legacy" });
  await peer.sendMessageToSession({ target: { pid: 0, messagingSocketPath: f.socketPath }, message: "raw legacy", raw: true });
  assert.equal(first.receipt, "unconfirmed");
  assert.doesNotMatch(f.frames[0].message.content, /from-mode=/);
  assert.equal(f.frames[1].message.content, "raw legacy");
});


test("agent requires a valid mode before registering its reply listener", async (t) => {
  const f = await fakeTarget(t);
  const result = spawnSync(process.execPath, [script, "agent", "--name", "invalid-mode-test",
    "--to", f.socketPath, "--message", "test only", "--from-mode", "auto"], {
    env: f.env, encoding: "utf8", timeout: 2000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sender|from-mode/i);
  assert.doesNotMatch(result.stdout, /Registered live peer/);
  assert.equal(fs.existsSync(f.env.CLAUDE_CONFIG_DIR), false);
});

test("receipt formatter correlates messages and preserves held/terminal states", () => {
  assert.equal(typeof peer.formatDeliveryReceipt, "function");
  for (const status of ["held", "delivered", "denied", "refused", "dropped", "expired"]) {
    const text = peer.formatDeliveryReceipt({
      type: "control", action: "peer_message_status", orig_msg_id: "message-123", status,
      reason: "permission-mode parity\nsecond line",
    });
    assert.match(text, new RegExp(`DELIVERY ${status.toUpperCase()}`));
    assert.match(text, /message-123/);
    assert.ok(!text.includes("\n"));
  }
  assert.equal(peer.formatDeliveryReceipt({ type: "control", action: "peer_idle_notice" }), null);
});

for (const status of ["held", "delivered"]) {
  test(`agent reports an asynchronous ${status} receipt with the message ID`, async (t) => {
    const f = await fakeTarget(t, status);
    f.child = spawn(process.execPath, [script, "agent", "--name", `peer-test-${process.pid}-${status}`,
      "--to", f.socketPath, "--message", "isolated test", "--from-mode", "prompting"], {
      cwd: root, env: f.env, stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`No ${status} receipt reported: ${text}`)), 4000);
      const inspect = (chunk) => {
        text += chunk;
        if (text.includes(`DELIVERY ${status.toUpperCase()}`) && text.includes("Frame written")) {
          clearTimeout(timer);
          resolve(text);
        }
      };
      f.child.stdout.on("data", inspect);
      f.child.stderr.on("data", inspect);
      f.child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Agent exited ${code}: ${text}`)); });
    });
    assert.ok(output.includes(f.frames.find((frame) => frame.type === "user").msg_id));
    assert.doesNotMatch(output, /Sent initial message/);
    if (status === "held") assert.match(output, /permission-mode parity/);
  });
}

test("new relay refuses omitted sender policy before registering a listener", (t) => {
  const result = spawnSync(process.execPath, [script, "agent", "--codex-thread", "11111111-2222-4333-8444-555555555555", "--to", "missing-source"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /from-mode/);
  assert.doesNotMatch(result.stdout, /Registered/);
});

test("legacy CLI send without mode still writes an omitted policy attribute", async (t) => {
  const f = await fakeTarget(t);
  const child = spawn(process.execPath, [script, "send", "--to", f.socketPath, "--message", "legacy CLI"], {
    env: f.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /receipt unconfirmed/);
  assert.equal(f.frames.length, 1);
  assert.doesNotMatch(f.frames[0].message.content, /from-mode=/);
});


test("relay routing CLI rejects missing, unknown and unbound modes before registering a daemon", () => {
  const script = path.join(root, "bin/consessus.mjs");
  for (const args of [["--relay-routing"], ["--relay-routing", "steer"], ["--relay-routing", "hybrid"]]) {
    const result = spawnSync(process.execPath, [script, "agent", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /--relay-routing/);
    assert.doesNotMatch(result.stdout, /Registered live peer agent/);
  }
});
