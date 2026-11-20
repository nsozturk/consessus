import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Version 1 was built and tested with exactly these. See docs/COMPATIBILITY.md.
export const TESTED = [
  { id: "macos", label: "macOS", version: "27.2" },
  { id: "node", label: "Node.js", version: "26.13.1" },
  { id: "claude-cli", label: "Claude Code CLI", version: "2.1.294" },
  { id: "claude-desktop", label: "Claude Desktop app", version: "5.11492.5" },
  { id: "codex-cli", label: "Codex CLI", version: "0.163.0" },
  { id: "codex-desktop", label: "ChatGPT / Codex desktop app", version: "26.1111.71025" },
  { id: "opencode-cli", label: "OpenCode CLI", version: "2.3.2" },
  { id: "opencode-desktop", label: "OpenCode desktop app", version: "1.19.5" },
  { id: "antigravity-cli", label: "Antigravity CLI (agy)", version: "1.5.12" },
  { id: "antigravity-app", label: "Antigravity app", version: "2.33.0" },
  { id: "antigravity-ide", label: "Antigravity IDE app", version: "2.6.0" },
];

const first = /(\d+(?:\.\d+)+)/;
const command = (file, args) => async () => first.exec((await exec(file, args, { timeout: 8000 })).stdout)?.[1] ?? null;
const bundle = name => command("/usr/bin/defaults", ["read", `/Applications/${name}.app/Contents/Info`, "CFBundleShortVersionString"]);

export const PROBES = {
  macos: command("/usr/bin/sw_vers", ["-productVersion"]),
  node: async () => process.versions.node,
  "claude-cli": command("claude", ["--version"]),
  "claude-desktop": bundle("Claude"),
  "codex-cli": command("codex", ["--version"]),
  "codex-desktop": bundle("ChatGPT"),
  "opencode-cli": command("opencode", ["--version"]),
  "opencode-desktop": bundle("OpenCode"),
  "antigravity-cli": command("agy", ["--version"]),
  "antigravity-app": bundle("Antigravity"),
  "antigravity-ide": bundle("Antigravity IDE"),
};

export async function checkVersions(probes = PROBES) {
  return Promise.all(TESTED.map(async row => {
    let installed = null;
    try { installed = await probes[row.id]?.() ?? null; } catch {}
    const status = installed === null ? "not installed" : installed === row.version ? "tested" : "differs";
    return { ...row, installed, status };
  }));
}

export function formatDoctor(rows) {
  const pad = (text, width) => String(text).padEnd(width);
  const lines = rows.map(row => `${pad(row.id, 18)} ${pad(row.label, 30)} tested ${pad(row.version, 15)} installed ${pad(row.installed ?? "-", 15)} ${row.status}`);
  const differing = rows.filter(row => row.status === "differs").length;
  if (differing) {
    lines.push("", `${differing} component${differing === 1 ? " differs" : "s differ"} from the tested versions. Consessus relies on undocumented behaviour of these apps, so a different version may not work. See docs/COMPATIBILITY.md.`);
  } else {
    lines.push("", "Every installed component matches a tested version.");
  }
  return lines.join("\n") + "\n";
}
