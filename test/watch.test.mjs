import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { watchSessions, formatWatchEvent } from "../src/watch.mjs";

// Each poll asks every source once; `plan[n]` is what each app answers on poll n (an Error means unavailable).
// The poll after the last step aborts the watch.
function scripted(plan, controller) {
  let poll = -1;
  const apps = [...new Set(plan.flatMap(step => Object.keys(step)))];
  return apps.map(app => [app, async () => {
    if (app === apps[0]) poll++;
    if (poll >= plan.length) { controller.abort(); return []; }
    const answer = plan[poll][app] ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }]);
}
const run = async (plan, options = {}) => {
  const controller = new AbortController(), events = [];
  await watchSessions({ intervalMs: 1, sources: scripted(plan, controller), onChange: event => events.push(event), signal: controller.signal, ...options });
  return events.map(({ t, ...rest }) => { assert.match(t, /^\d{4}-\d\d-\d\dT/); return rest; });
};
const s = (id, status = "idle", extra = {}) => ({ id, status, path: `/p/${id}`, ...extra });

test("the first poll is a silent baseline; later polls report appeared, gone and status changes only", async () => {
  const events = await run([
    { claude: [s("a"), s("b")], codex: [s("a", "open")] },
    { claude: [s("a"), s("b")], codex: [s("a", "open")] },
    { claude: [s("a", "busy"), s("c")], codex: [s("a", "open")] },
  ]);
  assert.deepEqual(events, [
    { type: "status", app: "claude", id: "a", path: "/p/a", from: "idle", to: "busy" },
    { type: "appeared", app: "claude", id: "c", path: "/p/c", to: "idle" },
    { type: "gone", app: "claude", id: "b", path: "/p/b", from: "idle" },
  ]);
});

test("an app that could not be asked keeps its sessions until it answers again", async () => {
  const events = await run([
    { claude: [s("x")], codex: [s("t1", "open"), s("t2", "open")] },
    { claude: [s("x")], codex: new Error("socket gone") },
    { claude: [s("x")], codex: new Error("socket gone") },
    { claude: [s("x")], codex: [s("t2", "open"), { id: "t3", status: "open" }] },
  ]);
  assert.deepEqual(events.map(event => `${event.type}:${event.app}:${event.id}`), ["appeared:codex:t3", "gone:codex:t1"]);
  assert.equal(events[0].path, null);
});

test("a poll that fails as a whole reports nothing and the watch keeps going", async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "consessus-watch-")));
  const project = path.join(parent, "proj");
  fs.mkdirSync(project);
  const controller = new AbortController(), events = [];
  let poll = 0;
  const sources = [["claude", async () => {
    poll++;
    // The folder vanishes for a few polls; those polls fail before any source is asked.
    if (poll === 2) { fs.rmdirSync(project); setTimeout(() => fs.mkdirSync(project), 30); }
    if (poll === 4) controller.abort();
    return poll >= 3 ? [s("late", "idle", { path: project })] : [s("early", "idle", { path: project })];
  }]];
  await watchSessions({ project, intervalMs: 1, sources, onChange: event => events.push(event), signal: controller.signal });
  assert.ok(poll >= 4);
  assert.deepEqual(events.map(event => `${event.type}:${event.id}`), ["appeared:late", "gone:early"]);
});

test("stops at once on abort, even while a source never answers, and reports nothing after", async () => {
  const controller = new AbortController(), events = [];
  let calls = 0;
  const sources = [["claude", () => { calls++; return calls === 1 ? Promise.resolve([s("a")]) : new Promise(() => {}); }]];
  const started = Date.now();
  const watching = watchSessions({ intervalMs: 1, sources, onChange: event => events.push(event), signal: controller.signal });
  while (calls < 2) await new Promise(resolve => setTimeout(resolve, 2));
  controller.abort();
  await watching;
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(events, []);

  const idle = new AbortController();
  const sleeping = watchSessions({ intervalMs: 60_000, sources: [["claude", async () => []]], onChange: () => {}, signal: idle.signal });
  setTimeout(() => idle.abort(), 20);
  const before = Date.now();
  await sleeping;
  assert.ok(Date.now() - before < 1000);

  let asked = 0;
  await watchSessions({ intervalMs: 1, sources: [["claude", async () => { asked++; return []; }]], onChange: () => {}, signal: AbortSignal.abort() });
  assert.equal(asked, 0);
});

test("an abort that lands while a poll is answering drops that poll's changes", async () => {
  const controller = new AbortController(), events = [];
  let calls = 0;
  const sources = [["claude", async () => {
    calls++;
    if (calls === 2) { controller.abort(); return [s("never-reported")]; }
    return [];
  }]];
  await watchSessions({ intervalMs: 1, sources, onChange: event => events.push(event), signal: controller.signal });
  assert.deepEqual(events, []);
});

test("rejects a bad interval or a missing project folder before polling", async () => {
  let asked = 0;
  const sources = [["claude", async () => { asked++; return []; }]];
  for (const intervalMs of [0, -5, NaN, Infinity, "100"]) {
    await assert.rejects(watchSessions({ intervalMs, sources, onChange: () => {}, signal: AbortSignal.abort() }), /intervalMs/);
  }
  await assert.rejects(watchSessions({ project: path.join(os.tmpdir(), "consessus-no-such-folder-x"), sources, onChange: () => {} }), /ENOENT/);
  assert.equal(asked, 0);
});

test("formatWatchEvent writes one plain line per event", () => {
  const t = "2026-01-01T00:00:00.000Z";
  assert.equal(formatWatchEvent({ t, type: "status", app: "claude", id: "a", path: "/p a", from: "idle", to: "busy" }), `${t} status   claude a idle -> busy /p a`);
  assert.equal(formatWatchEvent({ t, type: "appeared", app: "codex", id: "b", path: null, to: "open" }), `${t} appeared codex b open -`);
  assert.equal(formatWatchEvent({ t, type: "gone", app: "opencode", id: "c", path: "/q", from: "idle" }), `${t} gone     opencode c idle /q`);
  const line = formatWatchEvent({ t, type: "gone", app: "claude", id: "x\ny", path: "/p\r\u2028\x1b[2J", from: "a\u202eb" });
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  assert.equal(line.split("\n").length, 1);
});

test("a long watch does not pile up abort listeners", async () => {
  const controller = new AbortController();
  let calls = 0, listening;
  const sources = [["claude", async () => {
    if (++calls === 25) { listening = getEventListeners(controller.signal, "abort").length; controller.abort(); }
    return [];
  }]];
  await watchSessions({ intervalMs: 1, sources, onChange: () => {}, signal: controller.signal });
  assert.ok(listening <= 1, `${listening} abort listeners left`);
});

test("rejects an interval too long for a timer instead of polling in a hot loop", async () => {
  let asked = 0;
  await assert.rejects(watchSessions({ intervalMs: 2 ** 31, sources: [["claude", async () => { asked++; return []; }]], onChange: () => {} }), /intervalMs/);
  assert.equal(asked, 0);
});

test("works without a signal, and an error thrown by onChange ends the watch", { timeout: 5000 }, async () => {
  let calls = 0;
  const sentinel = new Error("stop here");
  const sources = [["claude", async () => (++calls === 1 ? [] : [s("a")])]];
  await assert.rejects(watchSessions({ intervalMs: 1, sources, onChange: () => { throw sentinel; } }), error => error === sentinel);
});
