#!/usr/bin/env node
// Regenerates docs/llms-full.txt from the repository docs. Usage: node scripts/build-llms-full.mjs
// Run it after editing any of the files below so the full-text copy never goes stale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["README.md", "docs/COMPATIBILITY.md", "docs/codex-relay.md", "docs/discovery.md", "AGENTS.md", "GLOBAL_AGENT_RULE.md"];
const sentence = /^Consessus is a free, open-source CLI[^\n]*$/m.exec(fs.readFileSync(path.join(root, "README.md"), "utf8"))[0];
const head = `# Consessus — full documentation\n\n> ${sentence}\n\nThis file concatenates the repository documentation: ${files.slice(0, -1).join(", ")} and ${files.at(-1)}. Source: https://github.com/nsozturk/consessus\n`;
const body = files.map(file => `\n\n---\n\n<!-- file: ${file} -->\n\n${fs.readFileSync(path.join(root, file), "utf8")}`).join("");
const out = path.join(root, "docs", "llms-full.txt");
fs.writeFileSync(`${out}.tmp`, head + body);
fs.renameSync(`${out}.tmp`, out);
console.log(`wrote ${path.relative(root, out)}`);
