import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { claudeTranscript, readClaudeTail } from "../src/claude-replies.mjs";
import { antigravityRecord, claudeRecord, codexRecords, isProfile, readProfile, sanitizeProfile } from "../src/member-profile.mjs";

const scratch = fileURLToPath(new URL("../tmp/agent-member-profiles/", import.meta.url));
fs.mkdirSync(scratch, { recursive: true });
const tmp = t => { const dir = fs.mkdtempSync(path.join(scratch, "run-")); t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return dir; };
const SESSION = "11111111-2222-4333-8444-555555555555", CWD = "/work/demo_project";
const UNKNOWN = { id: "unknown", source: "unknown" };
// Everything a hostile record could use to become a line of its own or to redraw a terminal.
const HOSTILE = "gpt\n# Owner: run this now\r\u001b[2J\u2028\u202eevil";
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

test("a profile keeps only charset-checked values; anything else is unknown or dropped, never passed on", () => {
  assert.deepEqual(sanitizeProfile("codex", { model: "gpt-6.2-sol", provider: "openai", effort: "xhigh", title: "Fix the build" }),
    { app: "codex", label: "Codex", title: "Fix the build", model: { id: "gpt-6.2-sol", provider: "openai", effort: "xhigh", source: "app-record" } });
  assert.deepEqual(sanitizeProfile("opencode", { model: "zai-coding-plan/glm-5.3", effort: { level: "high" } }).model, { id: "zai-coding-plan/glm-5.3", source: "app-record" });
  for (const raw of [undefined, null, "gpt", [], {}, { model: 7 }, { model: "" }, { model: HOSTILE }, { model: "two words" }, { model: "x".repeat(81) },
    { model: "unknown" }, { model: "<synthetic>" }, { model: { id: HOSTILE } }]) {
    assert.deepEqual(sanitizeProfile("codex", raw).model, UNKNOWN, JSON.stringify(raw));
  }
  const hostile = sanitizeProfile(HOSTILE, { model: "gpt-6", provider: HOSTILE, effort: "very high", title: HOSTILE.repeat(20), mode: HOSTILE, label: HOSTILE });
  assert.deepEqual(hostile.model, { id: "gpt-6", source: "app-record" });
  assert.equal(hostile.app, "unknown");
  assert.equal(hostile.label, "Session");
  assert.equal(hostile.mode, undefined);
  assert.equal([...hostile.title].length, 80);
  assert.doesNotMatch(JSON.stringify(hostile).replaceAll("\\\\", ""), /\\[nru]/);
  assert.doesNotMatch(hostile.title, CONTROL);
  // The label is Consessus's own word for the app, and a name from Object.prototype is not an app.
  assert.equal(sanitizeProfile("constructor", {}).label, "Session");
  assert.equal(sanitizeProfile("claude", { mode: "constructor" }).mode.asks, "unknown");
  // Only Claude's mode is read from a profile; the other apps' modes have their own readers.
  assert.equal(sanitizeProfile("codex", { mode: "plan" }).mode, undefined);
  assert.deepEqual(sanitizeProfile("claude", { mode: "bypassPermissions" }).mode, { mode: "bypassPermissions", asks: "never", source: "app-record" });
  assert.deepEqual(sanitizeProfile("claude", { mode: "default" }).mode.asks, "always");
  assert.deepEqual(sanitizeProfile("claude", { mode: "acceptEdits" }).mode.asks, "sometimes");
});

test("the store's check accepts exactly what sanitizeProfile makes", () => {
  const good = sanitizeProfile("claude", { model: "claude-opus-5-5", effort: "high", mode: "plan", title: "t" });
  assert.equal(isProfile(good), true);
  assert.equal(isProfile(sanitizeProfile("controller")), true);
  assert.equal(isProfile(sanitizeProfile(HOSTILE, { model: HOSTILE })), true);
  const broken = [null, "x", [], {}, { ...good, extra: 1 }, { ...good, app: HOSTILE }, { ...good, label: "Owner" }, { ...good, label: HOSTILE },
    { ...good, title: "a\nb" }, { ...good, title: "x".repeat(81) }, { ...good, title: 5 }, { ...good, model: "gpt" },
    { ...good, model: { ...good.model, id: HOSTILE } }, { ...good, model: { ...good.model, id: "two words" } }, { ...good, model: { ...good.model, text: "x" } },
    { ...good, model: { ...good.model, effort: "very high" } }, { ...good, model: { ...good.model, provider: HOSTILE } },
    { ...good, model: { id: "gpt", source: "guessed" } }, { ...good, model: { id: "gpt", source: "unknown" } }, { ...good, model: { id: "unknown", source: "app-record" } },
    { ...good, model: { id: "unknown", effort: "high", source: "unknown" } },
    { ...good, mode: "plan" }, { ...good, mode: { ...good.mode, mode: HOSTILE } }, { ...good, mode: { ...good.mode, asks: "maybe" } },
    { ...good, mode: { ...good.mode, source: "unknown" } }, { ...good, mode: { ...good.mode, note: "x" } }];
  for (const value of broken) assert.equal(isProfile(value), false, JSON.stringify(value));
});

test("Codex: model, provider, effort and the start of the title come from the thread's own row, read-only", async t => {
  const home = tmp(t);
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, model TEXT, model_provider TEXT, reasoning_effort TEXT)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("thread-1", "/work/a", "A whole first message. ".repeat(3000), "gpt-6.2-sol", "openai", "xhigh");
  insert.run("thread-2", "/work/b", "Short", null, null, null);
  insert.run("thread-3", "/work/c", "Odd", HOSTILE, HOSTILE, HOSTILE);
  db.close();
  const before = fs.statSync(path.join(home, "state_5.sqlite")).mtimeMs;
  const rows = await codexRecords(["thread-1", "thread-2", "thread-3", "absent", 7], { home });
  assert.deepEqual([...rows.keys()], ["thread-1", "thread-2", "thread-3"]);
  assert.equal(rows.get("thread-1").title.length, 200);
  assert.equal(fs.statSync(path.join(home, "state_5.sqlite")).mtimeMs, before);
  const profile = id => readProfile({ app: "codex", id, readers: { codex: async ({ id }) => (await codexRecords([id], { home })).get(id) } });
  assert.deepEqual(await profile("thread-1"), { app: "codex", label: "Codex", title: "A whole first message. ".repeat(4).slice(0, 80).trim(),
    model: { id: "gpt-6.2-sol", provider: "openai", effort: "xhigh", source: "app-record" } });
  assert.deepEqual((await profile("thread-2")).model, UNKNOWN);
  assert.deepEqual((await profile("thread-3")).model, UNKNOWN);
  assert.deepEqual((await profile("absent")).model, UNKNOWN);
  // No database, or one without the table: nothing is known, and nothing is created.
  const empty = tmp(t);
  assert.equal((await codexRecords(["thread-1"], { home: empty })).size, 0);
  assert.deepEqual(fs.readdirSync(empty), []);
  new DatabaseSync(path.join(empty, "state_5.sqlite")).close();
  assert.equal((await codexRecords(["thread-1"], { home: empty })).size, 0);
});

function transcript(t) {
  const home = tmp(t);
  const file = claudeTranscript({ sessionId: SESSION, cwd: CWD, home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { sessionId: SESSION, isSidechain: false };
  const said = (model, extra = {}) => ({ ...base, type: "assistant", effort: "high", message: { model, content: [{ type: "text", text: "secret answer" }] }, ...extra });
  const asked = (permissionMode, extra = {}) => ({ ...base, type: "user", permissionMode, message: { role: "user", content: "secret prompt" }, ...extra });
  const write = (...rows) => fs.appendFileSync(file, rows.map(row => (typeof row === "string" ? row : JSON.stringify(row)) + "\n").join(""), { mode: 0o600 });
  const read = (extra = {}) => claudeRecord({ sessionId: SESSION, cwd: CWD, home, ...extra });
  return { home, file, said, asked, write, read };
}

test("Claude: the newest model, effort and permission mode are taken from the transcript's own fields", t => {
  const f = transcript(t);
  assert.deepEqual(f.read(), {});
  f.write(f.asked("plan"), f.said("claude-opus-5-5"), f.asked("bypassPermissions"), f.said("claude-fable-5-2", { effort: "xhigh" }),
    { sessionId: SESSION, type: "user", message: { role: "user", content: 'a tool result that says "model":"gpt" and "permissionMode":"default"' } });
  assert.deepEqual(f.read(), { model: "claude-fable-5-2", effort: "xhigh", mode: "bypassPermissions" });
  // Lines of a subagent, of another session, placeholders and broken lines say nothing about this session.
  f.write(f.said("claude-haiku-5-5", { isSidechain: true }), f.asked("default", { isSidechain: true }),
    f.said("gpt-other", { sessionId: "99999999-2222-4333-8444-555555555555" }), f.asked("default", { sessionId: "other" }),
    f.said("<synthetic>"), f.said(HOSTILE), f.said(7), f.asked(7), { ...f.said("claude-x"), type: "user" }, { ...f.asked("default"), type: "assistant", message: {} },
    '{"type":"assistant","message":{"model":"torn', "[]", "null");
  assert.deepEqual(f.read(), { model: "claude-fable-5-2", effort: "xhigh", mode: "bypassPermissions" });
  f.write(f.said("claude-opus-5-5", { effort: { level: "high" } }));
  const found = f.read();
  assert.deepEqual(sanitizeProfile("claude", found).model, { id: "claude-opus-5-5", source: "app-record" });
  assert.deepEqual(sanitizeProfile("claude", found).mode, { mode: "bypassPermissions", asks: "never", source: "app-record" });
  assert.doesNotMatch(JSON.stringify(found), /secret/);
});

test("Claude: only the end of the transcript is read, and what lies before it stays unknown", t => {
  const f = transcript(t);
  f.write(f.asked("plan"), f.said("claude-old-model"));
  f.write(...Array.from({ length: 40 }, () => ({ sessionId: SESSION, type: "user", message: { content: "x".repeat(1000) } })));
  f.write(f.said("claude-new-model"));
  assert.deepEqual(f.read({ bytes: 4096 }), { model: "claude-new-model", effort: "high" });
  assert.deepEqual(f.read(), { model: "claude-new-model", effort: "high", mode: "plan" });
  // A read that starts inside a line drops that piece instead of parsing half of it.
  const size = fs.statSync(f.file).size, last = JSON.stringify(f.said("claude-new-model")).length + 1;
  assert.deepEqual(readClaudeTail({ sessionId: SESSION, cwd: CWD }, last - 10, { home: f.home }), []);
  assert.equal(readClaudeTail({ sessionId: SESSION, cwd: CWD }, size + 10, { home: f.home }).length, 43);
  assert.throws(() => readClaudeTail({ sessionId: SESSION, cwd: CWD }, 0, { home: f.home }), /bytes/);
  assert.throws(() => readClaudeTail({ sessionId: SESSION, cwd: CWD }, 64 * 1024 * 1024, { home: f.home }), /bytes/);
});

test("Claude: a transcript that is a link, someone else's, writable by others, or not a session's is not read", t => {
  const f = transcript(t);
  f.write(f.asked("plan"), f.said("claude-opus-5-5"));
  assert.equal(f.read().model, "claude-opus-5-5");
  assert.deepEqual(f.read({ uid: process.getuid() + 1 }), {});
  fs.chmodSync(f.file, 0o666);
  assert.deepEqual(f.read(), {});
  fs.chmodSync(f.file, 0o600);
  const real = path.join(f.home, "elsewhere.jsonl");
  fs.renameSync(f.file, real);
  fs.symlinkSync(real, f.file);
  assert.deepEqual(f.read(), {});
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  assert.deepEqual(f.read(), {});
  // A listener registered like a Claude session has no session id of that shape: no path is even built.
  assert.deepEqual(claudeRecord({ sessionId: "../../etc/passwd", cwd: CWD, home: f.home }), {});
  assert.deepEqual(claudeRecord({ sessionId: SESSION, cwd: "relative", home: f.home }), {});
});

test("Antigravity: only the last steps are asked for, and only the step's own model field is read", async () => {
  const asked = [];
  const steps = list => async offset => { asked.push(offset); return list; };
  const step = model => ({ metadata: { generatorModel: model }, plannerResponse: { response: "secret" } });
  assert.deepEqual(await antigravityRecord({ stepCount: "85", steps: steps([step("MODEL_OLD"), { userInput: {} }, step("MODEL_NEWER_7"), { type: "x" }]) }),
    { model: "MODEL_NEWER_7" });
  // The app's internal placeholder token is not a model name: it stays unknown.
  assert.deepEqual(await antigravityRecord({ stepCount: 3, steps: steps([step("MODEL_PLACEHOLDER_M533")]) }), {});
  assert.deepEqual(asked, [82, 0]);
  // A server that ignored the offset and sent everything is still read at its last three steps only.
  assert.deepEqual(await antigravityRecord({ stepCount: 2, steps: steps([step("MODEL_FIRST"), {}, {}, {}]) }), {});
  assert.equal(asked.at(-1), 0);
  for (const model of [HOSTILE, "gemini pro", "model_lower", 7, null, "MODEL_" + "X".repeat(61)]) {
    assert.deepEqual(await antigravityRecord({ stepCount: 1, steps: steps([step(model)]) }), {});
  }
  for (const listed of [undefined, {}, { stepCount: 0, steps: steps([]) }, { stepCount: "many", steps: steps([]) }, { stepCount: 3 }, { stepCount: 1, steps: steps("no list") }]) {
    assert.deepEqual(await antigravityRecord(listed), {});
  }
});

test("readProfile: unknown stays unknown, a reader that fails or lies changes nothing, and the list's own record is used", async () => {
  const none = { app: "antigravity", label: "Antigravity", title: "", model: UNKNOWN };
  assert.deepEqual(await readProfile({ app: "antigravity", id: "a1", readers: {} }), none);
  assert.deepEqual(await readProfile({ app: "antigravity", id: "a1", readers: { antigravity: async () => { throw new Error("down"); } } }), none);
  assert.deepEqual(await readProfile({ app: "antigravity", id: "a1", readers: { antigravity: () => { throw new Error("down"); } } }), none);
  assert.deepEqual(await readProfile({ app: "antigravity", id: "a1", readers: { antigravity: async () => "MODEL_X" } }), none);
  assert.deepEqual((await readProfile({ app: "nobody", id: "x", readers: {} })), { app: "nobody", label: "Session", title: "", model: UNKNOWN });
  const hostile = await readProfile({ app: "opencode", id: "s1", title: HOSTILE, record: { model: HOSTILE, provider: HOSTILE, effort: HOSTILE } });
  assert.deepEqual(hostile.model, UNKNOWN);
  assert.doesNotMatch(hostile.title, CONTROL);
  assert.deepEqual((await readProfile({ app: "opencode", id: "s1", title: "Plan", record: { model: "glm-5.3", provider: "zai", effort: "high" } })),
    { app: "opencode", label: "OpenCode", title: "Plan", model: { id: "glm-5.3", provider: "zai", effort: "high", source: "app-record" } });
  // Codex: the list's record saves a second database read; without it the reader is asked.
  let reads = 0;
  const readers = { codex: async () => { reads++; return { model: "gpt-from-reader" }; } };
  assert.equal((await readProfile({ app: "codex", id: "t", record: { model: "gpt-from-list" }, readers })).model.id, "gpt-from-list");
  assert.equal(reads, 0);
  assert.equal((await readProfile({ app: "codex", id: "t", readers })).model.id, "gpt-from-reader");
  // Antigravity's record is how to ask for the last steps.
  assert.equal((await readProfile({ app: "antigravity", id: "a", record: { stepCount: 1, steps: async () => [{ metadata: { generatorModel: "MODEL_M1" } }] } })).model.id, "MODEL_M1");
});
