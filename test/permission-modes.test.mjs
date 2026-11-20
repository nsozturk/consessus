import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexMode, antigravityMode, opencodeMode, modeHint } from "../src/permission-modes.mjs";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "consessus-modes-"));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

test("Codex: reads the app-wide mode and prefers a chat's own approval policy", () => {
  const home = dir();
  const state = mode => write(path.join(home, ".codex-global-state.json"), JSON.stringify({ "electron-owner-atoms:abc": {
    "agent-mode-by-host-id": { local: mode },
    "heartbeat-thread-permissions-by-id": { "t-never": { approvalPolicy: "never" }, "t-ask": { approvalPolicy: "on-request" } },
  } }));
  state("full-access");
  assert.deepEqual(codexMode({ home }), { mode: "full-access", asks: "never" });
  assert.deepEqual(codexMode({ home, thread: "t-ask" }), { mode: "approval on-request", asks: "always" });
  assert.deepEqual(codexMode({ home, thread: "t-unknown" }), { mode: "full-access", asks: "never" });
  state("guardian-approvals");
  assert.deepEqual(codexMode({ home }), { mode: "guardian-approvals", asks: "sometimes" });
  assert.deepEqual(codexMode({ home, thread: "t-never" }), { mode: "approval never", asks: "never" });
  state("something-new");
  assert.deepEqual(codexMode({ home }), { mode: "something-new", asks: "unknown" });
  assert.deepEqual(codexMode({ home: dir() }), { mode: "unknown", asks: "unknown" });
});

test("Antigravity: a conversation's own preset wins over the global one", () => {
  const home = dir(), config = write(path.join(dir(), "config.json"), JSON.stringify({ userSettings: { permissionPreset: "AGENT_PERMISSION_PRESET_TURBO" } }));
  assert.deepEqual(antigravityMode({ home, config, conversation: "c1" }), { mode: "turbo", asks: "never" });
  write(path.join(home, "annotations", "c1.pbtxt"), 'title:"AGENT_PERMISSION_PRESET_TURBO is only a title" permission_preset:AGENT_PERMISSION_PRESET_REQUEST_REVIEW');
  assert.deepEqual(antigravityMode({ home, config, conversation: "c1" }), { mode: "request-review", asks: "always" });
  write(path.join(home, "annotations", "c2.pbtxt"), "agent_permission_preset: AGENT_PERMISSION_PRESET_AUTO");
  assert.deepEqual(antigravityMode({ home, config, conversation: "c2" }), { mode: "auto", asks: "sometimes" });
  write(path.join(home, "outside.pbtxt"), "permission_preset:AGENT_PERMISSION_PRESET_REQUEST_REVIEW");
  assert.deepEqual(antigravityMode({ home, config, conversation: "../outside" }), { mode: "turbo", asks: "never" });
  write(path.join(home, "annotations", "c3.pbtxt"), 'title:"my notes permission_preset:AGENT_PERMISSION_PRESET_REQUEST_REVIEW"');
  assert.deepEqual(antigravityMode({ home, config, conversation: "c3" }), { mode: "turbo", asks: "never" });
  assert.deepEqual(antigravityMode({ home, config: path.join(home, "missing.json"), conversation: "c9" }), { mode: "unknown", asks: "unknown" });
});

test("OpenCode: reads the rule file with comments and reports mixed rules as sometimes", () => {
  const file = rules => write(path.join(dir(), "opencode.json"), `{\n  // a "comment" with // slashes\n  "url": "http://x/y", /* block */\n  "permission": ${rules}\n}`);
  assert.deepEqual(opencodeMode({ config: file('{ "*": "allow", "bash": { "*": "allow", "rm *": "deny" } }') }), { mode: "allow", asks: "never" });
  assert.deepEqual(opencodeMode({ config: file('{ "*": "ask" }') }), { mode: "ask", asks: "always" });
  assert.deepEqual(opencodeMode({ config: file('{ "*": "allow", "edit": "ask" }') }), { mode: "mixed", asks: "sometimes" });
  assert.deepEqual(opencodeMode({ config: file('"allow"') }), { mode: "allow", asks: "never" });
  assert.deepEqual(opencodeMode({ config: path.join(dir(), "none.json") }), { mode: "default", asks: "always" });
});

test("hints tell the owner where to change a mode and never offer to change it", () => {
  for (const app of ["codex", "antigravity", "opencode", "claude"]) {
    const hint = modeHint(app);
    assert.match(hint, /you|your/i);
    assert.doesNotMatch(hint, /consessus (will|can) (change|set)/i);
  }
  assert.match(modeHint("codex"), /Full access/);
  assert.match(modeHint("antigravity"), /Turbo/);
  assert.match(modeHint("opencode"), /opencode\.json/);
});
