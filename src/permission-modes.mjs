import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reads how each app is set to treat tool approvals. Read-only by design: a permission mode
// belongs to the person at the keyboard, so Consessus reports it and never changes it.
// `asks` is "never" | "sometimes" | "always" | "unknown".

const UNKNOWN = { mode: "unknown", asks: "unknown" };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };

const CODEX_MODES = { "full-access": "never", "guardian-approvals": "sometimes" };
const CODEX_POLICIES = { never: "never", "on-request": "always", "on-failure": "sometimes", untrusted: "always" };

export function codexMode({ home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), thread } = {}) {
  const state = readJson(path.join(home, ".codex-global-state.json"));
  const atoms = Object.entries(state ?? {}).find(([key]) => key.startsWith("electron-owner-atoms"))?.[1];
  if (!atoms || typeof atoms !== "object") return UNKNOWN;
  const policy = thread === undefined ? undefined : atoms["heartbeat-thread-permissions-by-id"]?.[thread]?.approvalPolicy;
  if (typeof policy === "string") return { mode: `approval ${policy}`, asks: CODEX_POLICIES[policy] ?? "unknown" };
  const mode = atoms["agent-mode-by-host-id"]?.local;
  return typeof mode === "string" ? { mode, asks: CODEX_MODES[mode] ?? "unknown" } : UNKNOWN;
}

const PRESETS = { TURBO: "never", AUTO: "sometimes", DEFAULT: "sometimes", VETTED: "sometimes", REQUEST_REVIEW: "always", NONE: "always" };
const preset = token => {
  const name = /^AGENT_PERMISSION_PRESET_([A-Z_]+)$/.exec(token ?? "")?.[1];
  return name && name !== "UNSPECIFIED" ? { mode: name.toLowerCase().replaceAll("_", "-"), asks: PRESETS[name] ?? "unknown" } : undefined;
};

export function antigravityMode({ home = path.join(os.homedir(), ".gemini", "antigravity"),
  config = path.join(os.homedir(), ".gemini", "config", "config.json"), conversation } = {}) {
  // A conversation only carries its own preset when it differs from the global one.
  if (typeof conversation === "string" && /^[A-Za-z0-9-]{1,80}$/.test(conversation)) {
    let text = "";
    try { text = fs.readFileSync(path.join(home, "annotations", `${conversation}.pbtxt`), "utf8"); } catch {}
    const own = preset(/(?:^|\s)[a-z_]*permission_preset\s*:\s*(AGENT_PERMISSION_PRESET_[A-Z_]+)/.exec(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))?.[1]);
    if (own) return own;
  }
  return preset(readJson(config)?.userSettings?.permissionPreset) ?? UNKNOWN;
}

function stripJsonComments(text) {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (inString) { out += char; if (char === "\\") out += text[++i] ?? ""; else if (char === '"') inString = false; continue; }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (char === "/" && next === "*") { i = text.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function opencodeMode({ config = path.join(os.homedir(), ".config", "opencode", "opencode.json") } = {}) {
  let rules;
  try { rules = JSON.parse(stripJsonComments(fs.readFileSync(config, "utf8")))?.permission; } catch {}
  // With no rule file OpenCode asks before tools run.
  if (rules === undefined) return { mode: "default", asks: "always" };
  const actions = new Set();
  const collect = value => {
    if (typeof value === "string") actions.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(rules);
  actions.delete("deny");
  if (actions.size === 1) return actions.has("allow") ? { mode: "allow", asks: "never" } : { mode: "ask", asks: actions.has("ask") ? "always" : "unknown" };
  return actions.size ? { mode: "mixed", asks: "sometimes" } : UNKNOWN;
}

const HINTS = {
  codex: "In Codex, you change it with the permission selector under the message box: Ask for approval, Approve for me or Full access.",
  antigravity: "In Antigravity, you change it with the permission selector in the chat input bar or in Settings: Request Review, Default, Auto or Turbo.",
  opencode: "In OpenCode, you change it by editing the permission rules in your opencode.json (ask or allow per tool).",
  claude: "In Claude Code, you change it in that session yourself (the permission mode of the session).",
};
export const modeHint = app => HINTS[app] ?? "You change the permission mode in that app yourself.";

export function sessionMode(app, id, options = {}) {
  if (app === "codex") return codexMode({ ...options, thread: id });
  if (app === "antigravity") return antigravityMode({ ...options, conversation: id });
  if (app === "opencode") return opencodeMode(options);
  return UNKNOWN;
}
