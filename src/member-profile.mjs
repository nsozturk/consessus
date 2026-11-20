import os from "node:os";
import path from "node:path";
import { readClaudeTail } from "./claude-replies.mjs";

// A profile says what a session is: its app, its model and, for Claude, its permission mode. Every value is
// read from the app's own record, read-only and bounded. A value that cannot be read is "unknown", never guessed.
// A profile is data from another app that Consessus later writes, unquoted, into lines of its own, so nothing
// free-form survives: the label comes from a fixed table and every other field must match a no-space charset.

const LABELS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", controller: "Controller" };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const ASKS = new Set(["never", "sometimes", "always", "unknown"]);
const MAX_TITLE = 80;
// How Claude Code's permission modes treat a tool call. A mode this table does not know asks "unknown".
const CLAUDE_MODES = { default: "always", plan: "always", acceptEdits: "sometimes", auto: "sometimes", bypassPermissions: "never", dontAsk: "never" };

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const word = value => typeof value === "string" && WORD.test(value) ? value : undefined;
const labelOf = app => Object.hasOwn(LABELS, app) ? LABELS[app] : "Session";
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));

// Makes a storable profile out of whatever a reader returned: anything that is not exactly right is dropped.
export function sanitizeProfile(app, raw) {
  const from = record(raw) ? raw : {};
  const model = record(from.model) ? from.model : { id: from.model, provider: from.provider, effort: from.effort };
  const id = typeof model.id === "string" && MODEL_ID.test(model.id) && model.id !== "unknown" ? model.id : undefined;
  const provider = word(model.provider), effort = word(model.effort);
  const mode = word(record(from.mode) ? from.mode.mode : from.mode);
  const kind = word(app) ?? "unknown";
  return {
    app: kind, label: labelOf(kind),
    title: typeof from.title === "string" ? [...from.title.replace(new RegExp(CONTROL, "g"), " ").trim()].slice(0, MAX_TITLE).join("") : "",
    model: id ? { id, ...(provider ? { provider } : {}), ...(effort ? { effort } : {}), source: "app-record" } : { id: "unknown", source: "unknown" },
    ...(mode && kind === "claude" ? { mode: { mode, asks: Object.hasOwn(CLAUDE_MODES, mode) ? CLAUDE_MODES[mode] : "unknown", source: "app-record" } } : {}),
  };
}

// The check the room store applies before a profile is written to disk or accepted from it.
export function isProfile(value) {
  if (!record(value) || !only(value, ["app", "label", "title", "model", "mode"])) return false;
  const { app, label, title, model, mode } = value;
  return word(app) !== undefined && label === labelOf(app)
    && typeof title === "string" && [...title].length <= MAX_TITLE && !CONTROL.test(title)
    && record(model) && only(model, ["id", "provider", "effort", "source"])
    && (model.source === "unknown" ? model.id === "unknown" && Object.keys(model).length === 2
      : model.source === "app-record" && typeof model.id === "string" && MODEL_ID.test(model.id) && model.id !== "unknown"
        && (model.provider === undefined || word(model.provider) !== undefined) && (model.effort === undefined || word(model.effort) !== undefined))
    && (mode === undefined || (record(mode) && only(mode, ["mode", "asks", "source"]) && word(mode.mode) !== undefined
      && ASKS.has(mode.asks) && mode.source === "app-record"));
}

// Codex keeps model, provider, effort and title per thread in its own state database. The title can be a
// whole first message, so only its start is asked for.
export async function codexRecords(ids, { home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
  const rows = new Map();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"), { readOnly: true });
    try {
      const query = db.prepare("SELECT cwd, substr(title, 1, 200) AS title, model, model_provider AS provider, reasoning_effort AS effort FROM threads WHERE id = ?");
      for (const id of ids.slice(0, 200)) {
        const row = typeof id === "string" ? query.get(id) : undefined;
        if (row) rows.set(id, { ...row });
      }
    } finally { db.close(); }
  } catch {}
  return rows;
}

// Claude Code writes the model on the assistant lines of a session's transcript and the permission mode on its
// prompt lines. Only the end of the file is read, and of a line only these fields: never its text.
const CLAUDE_TAIL = 2 * 1024 * 1024;
export function claudeRecord({ sessionId, cwd, home, uid, bytes = CLAUDE_TAIL } = {}) {
  let lines;
  try { lines = readClaudeTail({ sessionId, cwd }, bytes, { home, uid }); } catch {}
  const found = {};
  for (let i = (lines?.length ?? 0) - 1; i >= 0 && (found.model === undefined || found.mode === undefined); i--) {
    const line = lines[i];
    const wanted = (found.model === undefined && line.includes('"model"')) || (found.mode === undefined && line.includes('"permissionMode"'));
    if (!wanted) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!record(row) || row.sessionId !== sessionId || row.isSidechain === true) continue;
    // Claude Code marks lines it wrote itself with a placeholder such as "<synthetic>": that is not a model.
    if (found.model === undefined && row.type === "assistant" && typeof row.message?.model === "string" && MODEL_ID.test(row.message.model)) {
      found.model = row.message.model;
      found.effort = row.effort;
    }
    if (found.mode === undefined && row.type === "user" && typeof row.permissionMode === "string") found.mode = row.permissionMode;
  }
  return found;
}

// Antigravity's conversation list carries no model. Each step of a conversation records the model that
// produced it, so the last few steps are asked for (never the whole conversation) and only that field is read.
const ANTIGRAVITY_STEPS = 3;
export async function antigravityRecord({ stepCount, steps } = {}) {
  const count = Number(stepCount);
  if (typeof steps !== "function" || !Number.isSafeInteger(count) || count < 1) return {};
  const listed = await steps(Math.max(0, count - ANTIGRAVITY_STEPS));
  const model = (Array.isArray(listed) ? listed.slice(-ANTIGRAVITY_STEPS) : []).map(step => step?.metadata?.generatorModel)
    .filter(token => typeof token === "string" && /^MODEL_[A-Z0-9_]{1,60}$/.test(token))
    // An internal placeholder token names no model a reader could recognise: that is "unknown", not a model.
    .filter(token => !/^MODEL_PLACEHOLDER/.test(token)).at(-1);
  return model ? { model } : {};
}

export const defaultReaders = {
  claude: ({ id, path: cwd }) => claudeRecord({ sessionId: id, cwd }),
  codex: async ({ id }) => (await codexRecords([id])).get(id),
  // The session list already holds what these two apps record; it hands it over as `record`.
  antigravity: ({ record: listed }) => antigravityRecord(listed),
  opencode: ({ record: listed }) => listed,
};

// `record` is what the app's own session list already said about this session, when the caller has it.
export async function readProfile({ app, id, path: folder, title, record: listed, readers = defaultReaders } = {}) {
  let found;
  try {
    found = app === "codex" && record(listed) ? listed
      : typeof readers[app] === "function" ? await readers[app]({ id, path: folder, record: listed }) : undefined;
  } catch {}
  return sanitizeProfile(app, { ...(record(found) ? found : {}), title: title ?? found?.title });
}
