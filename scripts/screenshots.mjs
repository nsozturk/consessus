#!/usr/bin/env node
// Regenerates docs/assets/screenshots/*.png from real local runs of the CLI.
// Needs rsvg-convert (brew install librsvg). Usage: node scripts/screenshots.mjs
//
// The demo run uses a private scratch CONSESSUS_HOME and CLAUDE_CONFIG_DIR, so it never
// registers in, lists, or messages your real Claude sessions.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "consessus.mjs");
const outDir = path.join(root, "docs", "assets", "screenshots");
fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
const work = fs.mkdtempSync(path.join(root, "tmp", "screenshots-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const env = { ...process.env, FORCE_COLOR: "1" };
const run = (args, extraEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });

// Hide machine-specific paths: the repo checkout and the home directory.
const scrub = text => text.split(root).join("~/consessus").split(os.homedir()).join("~");

// --- ANSI -> SVG -----------------------------------------------------------
const COLORS = { 31: "#ff7b72", 32: "#70d6b0", 33: "#e3b341", 34: "#8b9aff", 35: "#e0a9ff", 36: "#79c0ff", 37: "#e6e8f2", 90: "#7d84a3" };
const FG = "#d7dbea", DIM = "#7d84a3", PROMPT = "#70d6b0";
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function lineToTspans(line) {
  let state = { bold: false, dim: false, color: null };
  let out = "";
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) {
      for (const code of (m[1] || "0").split(";").map(Number)) {
        if (code === 0) state = { bold: false, dim: false, color: null };
        else if (code === 1) state.bold = true;
        else if (code === 2) state.dim = true;
        else if (code === 22) state.bold = state.dim = false;
        else if (code === 39) state.color = null;
        else if (COLORS[code]) state.color = COLORS[code];
      }
      continue;
    }
    if (!part) continue;
    const fill = state.color || (state.dim ? DIM : FG);
    out += `<tspan fill="${fill}"${state.bold ? ' font-weight="bold"' : ""}>${esc(part)}</tspan>`;
  }
  return out;
}

function terminalSvg(title, lines) {
  const font = 14, lh = 21, cw = font * 0.602, pad = 28, top = 56;
  const plain = l => l.replace(/\x1b\[[0-9;]*m/g, "");
  const cols = Math.max(60, ...lines.map(l => plain(l).length));
  const w = Math.ceil(cols * cw + pad * 2), h = top + lines.length * lh + pad;
  const body = lines.map((l, i) =>
    `<text x="${pad}" y="${top + 8 + i * lh}" xml:space="preserve">${lineToTspans(l)}</text>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" rx="12" fill="#0b0f19"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="#2a3150"/>
<circle cx="24" cy="22" r="6" fill="#ff5f57"/><circle cx="44" cy="22" r="6" fill="#febc2e"/><circle cx="64" cy="22" r="6" fill="#28c840"/>
<text x="${w / 2}" y="27" fill="${DIM}" font-family="Menlo, monospace" font-size="13" text-anchor="middle">${esc(title)}</text>
<g font-family="Menlo, SF Mono, monospace" font-size="${font}">
${body}
</g>
</svg>`;
}

const prompt = cmd => `\x1b[32m$\x1b[0m \x1b[1m${cmd}\x1b[0m`;
const outputLines = text => scrub(text).replace(/\s+$/, "").split("\n");

function render(name, title, lines, zoom = 2) {
  const svg = path.join(work, `${name}.svg`), png = path.join(outDir, `${name}.png`);
  fs.writeFileSync(svg, terminalSvg(title, lines));
  const r = spawnSync("rsvg-convert", ["--zoom", String(zoom), svg, "-o", png], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`rsvg-convert failed for ${name}: ${r.stderr || r.error}`);
  console.log(`wrote ${path.relative(root, png)} (${Math.round(fs.statSync(png).size / 1024)} KB)`);
}

fs.mkdirSync(outDir, { recursive: true });
let agent;
try {
  // 01: help
  const help = run(["--help"]);
  // Commands section only: the full page is too tall for a readable image under 500 KB.
  const helpLines = outputLines(help.stdout);
  const cut = helpLines.findIndex(l => l.includes("OPTIONS:"));
  render("01-help", "consessus --help", [prompt("consessus --help"), ...helpLines.slice(0, cut),
    "\x1b[2m... per-command options follow; run consessus --help for the full page\x1b[0m"]);

  // 02: doctor (installed versions on this machine next to the tested ones)
  const doctor = run(["doctor"]);
  render("02-doctor", "consessus doctor", [prompt("consessus doctor"), ...outputLines(doctor.stdout + doctor.stderr)]);

  // 03: self-contained demo: listener with an inbox, a send, and a wait
  const home = path.join(work, "home"), claude = path.join(work, "claude");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(claude, { mode: 0o700 });
  const demoEnv = { CONSESSUS_HOME: home, CLAUDE_CONFIG_DIR: claude };
  let agentOut = "";
  agent = spawn(process.execPath, [cli, "agent", "--name", "demo-agent", "--inbox"], {
    env: { ...env, ...demoEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stdout.on("data", d => { agentOut += d; });
  agent.stderr.on("data", d => { agentOut += d; });
  for (let i = 0; i < 50 && !agentOut.includes("Listening"); i++) await sleep(100);
  if (!agentOut.includes("Listening")) throw new Error(`demo agent did not start:\n${agentOut}`);

  const message = "Hello from demo-sender. Can you review the draft?";
  const send = run(["send", "--to", "demo-agent", "--from-name", "demo-sender", "--from-mode", "prompting", "--message", message], demoEnv);
  if (send.status !== 0) throw new Error(`demo send failed:\n${send.stdout}${send.stderr}`);
  const wait = run(["wait", "--name", "demo-agent", "--timeout", "5"], demoEnv);
  if (wait.status !== 0) throw new Error(`demo wait failed (exit ${wait.status}):\n${wait.stderr}`);

  render("03-inbox-demo", "listener, send, wait", [
    prompt("consessus agent --name demo-agent --inbox &"),
    ...outputLines(agentOut),
    "",
    prompt(`consessus send --to demo-agent --from-name demo-sender \\`),
    `    \x1b[1m--from-mode prompting --message '${message}'\x1b[0m`,
    ...outputLines(send.stdout + send.stderr),
    "",
    prompt("consessus wait --name demo-agent"),
    ...outputLines(wait.stdout),
  ]);
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await new Promise(r => { agent.once("exit", r); setTimeout(r, 2000); });
  }
  fs.rmSync(work, { recursive: true, force: true }); // only this run's own scratch directory
}
