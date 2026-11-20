import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openAgentInbox, waitForAgentInbox } from "../src/agent-inbox.mjs";
import { openRoomStore } from "../src/room-store.mjs";
import { createRooms } from "../src/rooms.mjs";
import { requestJoin, sendRoomMessage } from "../src/room-cli.mjs";

const cli = fileURLToPath(new URL("../bin/consessus.mjs", import.meta.url));
const scratch = fileURLToPath(new URL("../tmp/agent-c2-fixture/", import.meta.url));
fs.mkdirSync(scratch, { recursive: true });

async function observe(read) {
  for (let i = 0; i < 100; i++) {
    const result = read();
    if (result) return result;
    await sleep(10);
  }
  throw new Error("Room fixture timed out");
}

async function bind(t, socket, receive) {
  const server = net.createServer(conn => {
    let buffer = "";
    conn.setEncoding("utf8").on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) receive(JSON.parse(line), line);
      }
    });
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
}

test("private room state and real Unix sockets deliver to the C1 inbox; no-TTY CLI approval is rejected", async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "c-")));
  const oldHome = process.env.CONSESSUS_HOME;
  const home = path.join(directory, "peer");
  process.env.CONSESSUS_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CONSESSUS_HOME;
    else process.env.CONSESSUS_HOME = oldHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const endpoint = name => ({ id: `claude:${name}`, sessionId: name, pid: process.pid,
    kind: "claude", address: `uds:${path.join(directory, name[0])}`, cwd: directory, procStart: "fixture-start" });
  const host = endpoint("host"), guest = endpoint("guest");
  const store = openRoomStore();
  const inbox = openAgentInbox("guest");
  t.after(() => inbox.close());
  let actor = guest;
  const identity = {
    discover: async () => [guest],
    isLive: async () => true,
    caller: async () => actor,
    attest: async (_project, { address, sessionId }) => {
      assert.equal(address, guest.address);
      assert.equal(sessionId, guest.sessionId);
      return guest;
    },
  };
  const rooms = createRooms({ store, identity, sendMessage: sendRoomMessage, sendJoin: requestJoin, code: () => "c0ffee00" });
  const errors = [];
  await bind(t, host.address.slice(4), frame => {
    if (frame.type === "control" && frame.action === "room_join") {
      rooms.acceptJoin(frame.room, { address: frame.from, sessionId: frame.from_session }).catch(err => errors.push(err));
    }
  });
  await bind(t, guest.address.slice(4), (frame, line) => inbox.append(frame, line));
  await rooms.open("work", { project: directory, controller: host, initiator: host, fromMode: "prompting", requireApproval: true });
  await rooms.join(undefined, { project: directory });
  await observe(() => store.readRoom("work").members.find(member => member.id === guest.id)?.state === "pending");

  const child = (args, extra) => spawnSync(process.execPath, [cli, "room", ...args], {
    cwd: directory, env: { ...process.env, CONSESSUS_HOME: home }, encoding: "utf8", timeout: 5000, ...extra,
  });
  const hidden = child(["status", "work"]);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.doesNotMatch(hidden.stdout, /c0ffee00|confirmationCode/);
  const refusal = child(["approve", "work", guest.id], { input: "c0ffee00\n" });
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /operator terminal/);
  assert.equal(store.readRoom("work").members.find(member => member.id === guest.id).state, "pending");
  let terminal;
  await t.test("agent ancestry blocks status codes and decisions even with a controlling TTY", {
    skip: process.platform !== "darwin",
  }, (terminalTest) => {
    const preload = path.join(directory, "process-fixture.cjs");
    fs.writeFileSync(preload, String.raw`
      const fs = require("node:fs");
      const tty = require("node:tty");
      const cp = require("node:child_process");
      const { promisify } = require("node:util");
      const { syncBuiltinESMExports } = require("node:module");
      const fd = fs.openSync("/dev/tty", "r+");
      if (!process.stdin.isTTY || !process.stdout.isTTY || !tty.isatty(fd)) throw Error("Missing fixture TTY");
      fs.closeSync(fd);
      const agent = process.env.ROOM_TEST_AGENT === "1";
      const execFile = () => { throw Error("Unexpected native call"); };
      execFile[promisify.custom] = async (binary, argv) => {
        if (binary === "/bin/ps") {
          const row = (pid, parent) => [pid, parent, process.getuid(), "Thu Nov 19 10:00:00 2026"].join(" ");
          return { stdout: row(process.pid, process.ppid) + "\n" + row(process.ppid, 1) };
        }
        if (agent && binary === "/usr/bin/codesign" && Number(argv.at(-1)) === process.ppid) {
          if (argv[0] === "-d") return { stderr: "Identifier=com.anthropic.claude-code\nTeamIdentifier=Q6L2SF6YDW\n" };
          if (argv[0] === "--verify") return { stdout: "" };
        }
        throw Error("Fixture has no matching signature");
      };
      cp.execFile = execFile;
      syncBuiltinESMExports();
    `);
    const stdin = fs.openSync("/dev/null", "r");
    t.after(() => fs.closeSync(stdin));
    // The fixture's own (empty) Claude folder: the command never reads this machine's sessions.
    terminal = (agent, ...args) => spawnSync("/usr/bin/script", [
      "-q", "/dev/null", process.execPath, "--require", preload, cli, "room", ...args,
    ], {
      cwd: directory, env: { ...process.env, ROOM_TEST_AGENT: agent ? "1" : "0", CLAUDE_CONFIG_DIR: path.join(directory, "claude-config") },
      encoding: "utf8", stdio: [stdin, "pipe", "pipe"], timeout: 5000,
    });
    const operator = terminal(false, "status", "work");
    assert.equal(operator.status, 0, operator.stdout + operator.stderr);
    assert.match(operator.stdout, /"confirmationCode": "c0ffee00"/);
    const agent = terminal(true, "status", "work");
    assert.equal(agent.status, 0, agent.stdout + agent.stderr);
    assert.doesNotMatch(agent.stdout, /c0ffee00|confirmationCode/);
    for (const action of ["approve", "deny"]) {
      const denied = terminal(true, action, "work", guest.id);
      assert.equal(denied.status, 1);
      assert.match(denied.stdout + denied.stderr, /operator terminal.*outside the agent/);
    }
    assert.equal(store.readRoom("work").members.find(member => member.id === guest.id).state, "pending");
  });
  await rooms.decide("work", guest.id, "approve", async () => "c0ffee00");
  actor = host;
  assert.deepEqual((await rooms.send("work", { to: guest.id, message: "fixture-room-body" })).map(row => row.status), ["sent"]);
  const printed = [];
  assert.equal(await waitForAgentInbox({ name: "guest", seconds: 2, all: true, json: true, write: line => printed.push(JSON.parse(line)) }), 0);
  assert.deepEqual(printed.map(row => row.frame.room_event), ["invite", "announce", "message"]);
  assert.equal(printed.at(-1).frame.room_member_id, host.id);
  assert.equal(printed.at(-1).frame.room, "work");
  assert.match(printed.at(-1).frame.message.content, /fixture-room-body/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, "rooms", "work.jsonl"), "utf8"), /fixture-room-body|c0ffee00/);
  assert.deepEqual(errors, []);
  await t.test("room lead and room set: an operator terminal is allowed, an agent's terminal with no session of its own is not", {
    skip: process.platform !== "darwin",
  }, () => {
    const kept = () => { const room = store.readRoom("work"); return [room.lead, room.discussion]; };
    assert.deepEqual(kept(), [host.id, undefined]);
    for (const args of [["lead", "work", guest.id], ["set", "work", "--discussion", "free", "--max-messages", "6"]]) {
      const refused = terminal(true, ...args);
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.deepEqual(kept(), [host.id, undefined]);
    }
    const lead = terminal(false, "lead", "work", guest.id);
    assert.equal(lead.status, 0, lead.stdout + lead.stderr);
    assert.match(lead.stdout, /"lead": "claude:guest"/);
    const set = terminal(false, "set", "work", "--discussion", "free", "--max-messages", "6");
    assert.equal(set.status, 0, set.stdout + set.stderr);
    assert.deepEqual(kept(), [guest.id, { mode: "free", maxMessages: 6 }]);
    for (const args of [["set", "work", "--discussion", "loud"], ["set", "work", "--discussion", "free", "--max-messages", "21"], ["set", "work"], ["lead", "work"]]) {
      assert.equal(terminal(false, ...args).status, 1);
    }
    assert.deepEqual(kept(), [guest.id, { mode: "free", maxMessages: 6 }]);
    const shown = terminal(false, "members", "work");
    assert.match(shown.stdout, /"role": "room lead"/);
    assert.doesNotMatch(fs.readFileSync(path.join(home, "rooms", "work.jsonl"), "utf8"), /fixture-room-body|c0ffee00/);
  });
  await t.test("room assign: refused from an agent's terminal and for a bad command line; an operator terminal is let through and gets a result", {
    skip: process.platform !== "darwin",
  }, async () => {
    const journal = () => fs.readFileSync(path.join(home, "rooms", "work.jsonl"), "utf8");
    const before = journal();
    for (const [agent, ...args] of [[true, `${guest.id}=fixture-task-body`], [false, "nobody=fixture-task-body"], [false, "fixture-task-body"],
      [false, `${guest.id}=fixture-task-body`, "--timeout", "1801"], [false, `${guest.id}=fixture-task-body`, "--to", "x"], [false]]) {
      const refused = terminal(agent, "assign", "work", ...args);
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.doesNotMatch(refused.stdout + refused.stderr, /fixture-task-body/);
    }
    assert.equal(journal(), before);
    assert.equal(store.readRoom("work").discussing, undefined);
    assert.equal(await waitForAgentInbox({ name: "guest", seconds: 0.2, all: true, json: true, write: () => {} }), 2);
    // The fixture's guest is not a session the command can verify as alive, so it is reported and not written to.
    const sent = terminal(false, "assign", "work", `${guest.id}=fixture-task-body, with a=b`, "--timeout", "1");
    assert.equal(sent.status, 0, sent.stdout + sent.stderr);
    assert.match(sent.stdout, /"memberId": "claude:guest"/);
    assert.match(sent.stdout, /"status": "unreachable",\s+"reason": "unreachable"/);
    // The progress line, printed as the result arrives. The fixture's terminal merges stderr into stdout.
    assert.match(sent.stdout + sent.stderr, /\[unreachable\] Claude \(claude:guest\): \(unreachable\)/);
    assert.doesNotMatch(sent.stdout + sent.stderr, /fixture-task-body/);
    assert.equal(await waitForAgentInbox({ name: "guest", seconds: 0.2, all: true, json: true, write: () => {} }), 2);
    assert.match(journal().slice(before.length), /"event":"assign".*"status":"1 assignments, 0 answered"/);
    assert.doesNotMatch(journal(), /fixture-task-body/);
    assert.equal(store.readRoom("work").discussing, undefined);
  });
});
