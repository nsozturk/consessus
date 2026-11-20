import test from "node:test";
import assert from "node:assert/strict";
import { TESTED, checkVersions, formatDoctor } from "../src/doctor.mjs";

test("compares installed versions with the tested ones without treating a missing app as an error", async () => {
  const probes = Object.fromEntries(TESTED.map(row => [row.id, async () => row.version]));
  probes["opencode-cli"] = async () => "9.9.9";
  probes["antigravity-ide"] = async () => null;
  probes["codex-cli"] = async () => { throw new Error("boom"); };
  const rows = await checkVersions(probes);
  const by = id => rows.find(row => row.id === id);
  assert.equal(rows.length, TESTED.length);
  assert.equal(by("claude-cli").status, "tested");
  assert.deepEqual([by("opencode-cli").status, by("opencode-cli").installed], ["differs", "9.9.9"]);
  assert.equal(by("antigravity-ide").status, "not installed");
  assert.equal(by("codex-cli").status, "not installed");
  const text = formatDoctor(rows);
  assert.match(text, /opencode-cli.*9\.9\.9.*differs/i);
  assert.match(text, /1 component differs from the tested versions/);
  assert.doesNotMatch(formatDoctor(rows.filter(row => row.status !== "differs")), /differs from the tested/);
});
