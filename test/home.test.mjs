import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stateHome } from "../src/home.mjs";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "consessus-home-"));

test("uses CONSESSUS_HOME first, then the old variable, and rejects a relative path", () => {
  assert.equal(stateHome({ env: { CONSESSUS_HOME: "/a", CLAUDE_PEER_HOME: "/b" }, homedir: "/h" }), "/a");
  assert.equal(stateHome({ env: { CLAUDE_PEER_HOME: "/b" }, homedir: "/h" }), "/b");
  assert.throws(() => stateHome({ env: { CONSESSUS_HOME: "rel" }, homedir: "/h" }), /absolute/);
});

test("keeps an existing claude-peer state directory until a consessus one exists, and never moves it", () => {
  const home = scratch();
  const notes = [];
  const warn = line => notes.push(line);
  assert.equal(stateHome({ env: {}, homedir: home, warn }), path.join(home, ".consessus"));
  assert.deepEqual(notes, []);
  fs.mkdirSync(path.join(home, ".claude-peer"));
  fs.writeFileSync(path.join(home, ".claude-peer", "keep"), "x");
  assert.equal(stateHome({ env: {}, homedir: home, warn }), path.join(home, ".claude-peer"));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\.claude-peer/);
  assert.ok(fs.existsSync(path.join(home, ".claude-peer", "keep")));
  assert.ok(!fs.existsSync(path.join(home, ".consessus")));
  fs.mkdirSync(path.join(home, ".consessus"));
  assert.equal(stateHome({ env: {}, homedir: home, warn }), path.join(home, ".consessus"));
  assert.equal(notes.length, 1);
});

test("the old command name still runs and says it was renamed", () => {
  const run = name => spawnSync(process.execPath, [path.resolve("bin", name), "--version"], { encoding: "utf8" });
  const current = run("consessus.mjs"), old = run("claude-peer.mjs");
  assert.equal(current.status, 0);
  assert.equal(current.stderr, "");
  assert.equal(old.status, 0);
  assert.equal(old.stdout, current.stdout);
  assert.match(old.stderr, /renamed.*consessus/i);
});
