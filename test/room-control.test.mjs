import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readRoomControl } from "../src/room-control.mjs";

test("owned listener input only dispatches membership actions with the listener's identity", async () => {
  const commands = [], errors = [];
  const input = Readable.from([
    '{"action":"join","room":"work","from-session":"spoofed"}\n',
    '{"action":"send","room":"work","all":true,"message":"fixture"}\n',
    '{"action":"approve","room":"work","member":"fixture"}\n',
    '{"action":"leave","room":"work"}\n',
    'not-json\n',
  ]);
  await readRoomControl({
    input, endpoint: { address: "uds:/fixture/worker.sock", sessionId: "worker", fromMode: "prompting" },
    dispatch: value => commands.push(value), reportError: error => errors.push(error),
  });
  assert.deepEqual(commands.map(cmd => cmd._[1]), ["join", "send", "leave"]);
  assert.ok(commands.every(cmd => cmd["from-session"] === "worker" && cmd["from-address"] === "uds:/fixture/worker.sock"));
  assert.equal(commands[1].message, "fixture");
  assert.equal(commands[1].all, true);
  assert.equal(errors.length, 2);
});
