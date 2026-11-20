#!/usr/bin/env node
// Checks that the FAQ is identical in README.md, the landing page (docs/index.html), the docs page
// (docs/docs/index.html, when it exists) and each page's FAQPage JSON-LD, and that every JSON-LD block parses.
// Usage: node scripts/check-faq.mjs
import fs from "node:fs";
const readme = fs.readFileSync("README.md", "utf8");
const faqMd = readme.slice(readme.indexOf("## FAQ\n"), readme.indexOf("## Alternatives"));
// An answer is everything up to the next question, with its paragraphs joined by one space.
const flat = t => t.trim().replace(/\s+/g, " ");
const md = faqMd.split(/^### /m).slice(1).map(q => [q.slice(0, q.indexOf("\n")), flat(q.slice(q.indexOf("\n")))]);
const dec = t => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const file of ["docs/index.html", "docs/docs/index.html"]) {
  if (file !== "docs/index.html" && !fs.existsSync(file)) continue;
  const page = fs.readFileSync(file, "utf8"), start = page.indexOf('<section id="faq"');
  // The FAQ section holds only <h3> questions and <p> answers, so it ends at its own closing tag.
  const faqHtml = start < 0 ? "" : page.slice(start, page.indexOf("</section>", start));
  const html = faqHtml.split("<h3>").slice(1).map(q => [dec(q.slice(0, q.indexOf("</h3>"))),
    flat([...q.matchAll(/<p>([\s\S]+?)<\/p>/g)].map(m => dec(m[1])).join(" "))]);
  const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  const ld = (blocks.find(b => b["@type"] === "FAQPage")?.mainEntity ?? []).map(q => [q.name, flat(q.acceptedAnswer.text)]);
  console.log(`${file}: json-ld blocks parsed: ${blocks.length}; faq pairs md=${md.length} html=${html.length} ld=${ld.length}`);
  if (!same(md, html) || !same(md, ld) || md.length === 0) { console.error(`FAQ MISMATCH in ${file}`); process.exit(1); }
}
console.log("FAQ identical in README, pages and JSON-LD");
