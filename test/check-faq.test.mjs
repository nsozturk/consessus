import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-faq.mjs", import.meta.url));

// Builds a tiny README and page in a scratch folder and runs the checker there.
// `second` gives the docs page (docs/docs/index.html) its own html and ld; without it that page does not exist.
function check({ md, html, ld, second }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consessus-faq-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "README.md"), `# X\n\n## FAQ\n\n### Does it work?\n\n${md.join("\n\n")}\n\n### And then?\n\nDone.\n\n## Alternatives\n`);
    const faqPage = ld => ({ "@type": "FAQPage", mainEntity: [["Does it work?", ld], ["And then?", "Done."]]
      .map(([name, text]) => ({ "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text } })) });
    const page = ({ html, ld }) => `<script type="application/ld+json">${JSON.stringify(faqPage(ld))}</script>
<section id="faq">
  <h3>Does it work?</h3>
${html.map(p => `  <p>${p}</p>`).join("\n")}
  <h3>And then?</h3>
  <p>Done.</p>
</section>
<section id="alternatives"></section>\n`;
    fs.writeFileSync(path.join(dir, "docs", "index.html"), page({ html, ld }));
    if (second) {
      fs.mkdirSync(path.join(dir, "docs", "docs"));
      fs.writeFileSync(path.join(dir, "docs", "docs", "index.html"), page(second));
    }
    return spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" }).status;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("the FAQ check compares every paragraph of an answer, not only the first", () => {
  const two = ["Yes.", "Only on a Mac."];
  assert.equal(check({ md: two, html: two, ld: "Yes. Only on a Mac." }), 0);
  assert.equal(check({ md: two, html: two, ld: "Yes." }), 1);
  assert.equal(check({ md: two, html: ["Yes."], ld: "Yes. Only on a Mac." }), 1);
  assert.equal(check({ md: ["Yes."], html: two, ld: "Yes." }), 1);
  assert.equal(check({ md: two, html: ["Yes.", "Only on a PC."], ld: "Yes. Only on a Mac." }), 1);
});

test("the FAQ check also compares the docs page when it exists", () => {
  const two = ["Yes.", "Only on a Mac."], ld = "Yes. Only on a Mac.";
  const first = { md: two, html: two, ld };
  assert.equal(check({ ...first, second: { html: two, ld } }), 0);
  assert.equal(check({ ...first, second: { html: ["Yes."], ld } }), 1);
  assert.equal(check({ ...first, second: { html: two, ld: "Yes." } }), 1);
  assert.equal(check({ ...first, second: { html: ["Yes.", "Only on a PC."], ld } }), 1);
});
