#!/usr/bin/env node
// Rewrites the no-JavaScript copy of the hero stage in docs/index.html from docs/assets/demo/hero-flow.json.
// Run from the repo root after changing hero-flow.json:  node scripts/demo/build-hero-static.mjs
// The markup must stay the same shape as render() in docs/assets/site/site.js.
import fs from "node:fs";
const flow = JSON.parse(fs.readFileSync("docs/assets/demo/hero-flow.json", "utf8"));
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const words = { command: "runs", incoming: "receives", working: "is working", answer: "answers", notice: "is told", result: "reads the answers" };
const name = id => { const p = flow.panes.find(p => p.id === id); return p ? `${p.app} (${p.role})` : id; };
const msg = s => {
  const cut = s.kind === "incoming" ? s.text.indexOf("\n") : -1;
  return `<div class="m k-${esc(s.kind)}">${cut > 0 ? `<div class="h">${esc(s.text.slice(0, cut))}</div>` : ""}<div class="b">${esc(cut > 0 ? s.text.slice(cut + 1) : s.text)}</div></div>`;
};
const wins = flow.panes.map(p => `      <div class="win w-${p.app.toLowerCase().replace(/[^a-z]/g, "")}" data-pane="${esc(p.id)}" style="--t:${esc(p.tint)}"><div class="bar"><i></i><b>${esc(p.app)}</b><span>${esc(p.role)}</span></div><div class="rail"></div><div class="log">${flow.steps.filter(s => s.at === p.id).map(msg).join("")}</div><div class="comp"><em>${esc(p.model || "")}</em></div></div>`).join("\n");
const said = flow.steps.filter(s => s.kind !== "working").map(s => `${name(s.at)} ${words[s.kind] || s.kind}: ${s.text.replace(/\s+/g, " ")}`).join(" ");
const via = [...flow.steps].reverse().find(s => s.via)?.via ?? "";
const cap = flow.provisional ? "Illustration of a room assign flow"
  : 'Recorded from one live room; the words are in the <a href="assets/demo/hero-flow.json">transcript</a>';
const block = `<!-- hero-flow:static BEGIN (copy of assets/demo/hero-flow.json for readers without JavaScript; regenerate it when that file changes) -->
    <p class="sr">Four app windows in room ${esc(flow.room)} exchange messages through Consessus. ${esc(said)}</p>
    <div class="stage-grid" aria-hidden="true">
      <div class="wins" tabindex="-1">
${wins}
      </div>
      <div class="hub"><b>Consessus</b><span class="hub-say">${esc(via)}</span></div>
      <i class="dot"></i>
    </div>
    <div class="stage-foot"><p class="stage-cap">${cap}</p><span class="stage-ctl" hidden><button type="button" data-act="pause">Pause</button><button type="button" data-act="replay">Replay</button></span></div>
    <!-- hero-flow:static END -->`;
const file = "docs/index.html", page = fs.readFileSync(file, "utf8");
const next = page.replace(/<!-- hero-flow:static BEGIN[\s\S]*?hero-flow:static END -->/, () => block);
if (next === page && !page.includes(block)) { console.error("markers not found in " + file); process.exit(1); }
fs.writeFileSync(file + ".tmp", next); fs.renameSync(file + ".tmp", file);
console.log(`static stage written: ${flow.panes.length} windows, ${flow.steps.length} steps, provisional=${flow.provisional}`);
