import test from "node:test";
import assert from "node:assert/strict";
import { selectCodexDelivery } from "../src/codex-routing.mjs";

test("omitted and explicit queue modes preserve queue-only delivery", () => {
  for (const content of ["hello", "[STEER] Stop all writes now.", "[QUEUE] Stop now.", ""]) {
    assert.equal(selectCodexDelivery(content), "queue");
    assert.equal(selectCodexDelivery(content, "queue"), "queue");
  }
});

test("hybrid recognizes only an exact leading STEER token", () => {
  for (const content of ["[STEER]", "[STEER] Stop now.", " \t\r\n[STEER]\nYön düzeltmesi: dur.", "\u2028[STEER]\u2029🛑", "\uFEFF[STEER]\tstop"]) {
    assert.equal(selectCodexDelivery(content, "hybrid"), "steer", JSON.stringify(content));
  }
  for (const content of ["[steer] Stop now.", "[Steer]", "[STEER]later", "[STEER]: stop", "[ STEER] stop", "prefix [STEER]", "[STEER_NOW] stop"]) {
    assert.equal(selectCodexDelivery(content, "hybrid"), "queue", content);
  }
});

test("the first token wins when markers conflict", () => {
  assert.equal(selectCodexDelivery("[QUEUE] [STEER] Stop all writes now.", "hybrid"), "queue");
  assert.equal(selectCodexDelivery("[STEER] [QUEUE] Continue normally.", "hybrid"), "steer");
  assert.equal(selectCodexDelivery("[QUEUE]\n[STEER] Stop now.", "hybrid"), "queue");
  assert.equal(selectCodexDelivery("[STEER][QUEUE]", "hybrid"), "queue");
});

test("quoted, fenced and nested-header markers remain queue data", () => {
  for (const content of [
    "> [STEER] stop", "\n  > [STEER] stop", '"[STEER] stop"', "`[STEER] stop`",
    "```text\n[STEER] stop\n```", "~~~\n[STEER] stop\n~~~",
    "[cross-session]\n[STEER] stop", "OWNER: [STEER] stop", "Lead, [STEER] stop",
    "Report:\n[STEER] stop", "Example:\n[STEER] stop",
  ]) {
    assert.equal(selectCodexDelivery(content, "hybrid"), "queue", content);
  }
});

test("unmarked commands, corrections, history and metadata never select steer", () => {
  for (const content of [
    "Stop all work now.", "Please stop all writing now.", "OWNER: stop all direct writes now.",
    "Lead, process issue: someone wrote to shared source. **Stop all direct writes now.**",
    "Hemen dur.", "Tüm işleri durdur.", "Yazmayı durdur.",
    "Direction correction: use the other branch.", "Scope correction: docs only.", "Yön düzeltmesi: devam et.",
    "Stopped jobs: 2", "Do not stop.", "The previous report said: stop now.",
    "Correction: 12 frames, not 11.", "Review status: complete.", '{"priority":"now"}',
  ]) {
    assert.equal(selectCodexDelivery(content, "hybrid"), "queue", content);
  }
});

test("empty and non-string bodies are not interpreted or coerced", () => {
  for (const content of ["", " \n\t", null, undefined, 1, [], { priority: "now", content: "[STEER] stop" }]) {
    assert.equal(selectCodexDelivery(content, "hybrid"), "queue");
  }
});

test("invalid routing modes fail even for an empty or ordinary body", () => {
  for (const routing of ["", "steer", "Hybrid", "QUEUE", null, 0, {}]) {
    assert.throws(() => selectCodexDelivery("", routing), /routing must be "queue" or "hybrid"/);
    assert.throws(() => selectCodexDelivery("hello", routing), /routing must be "queue" or "hybrid"/);
  }
});

test("selection leaves the body and its leading marker intact", () => {
  const content = " \r\n[STEER] Yön düzeltmesi: 🛑\n> quoted peer data\n```\n$()\n```";
  const before = JSON.stringify(content);
  assert.equal(selectCodexDelivery(content, "hybrid"), "steer");
  assert.equal(JSON.stringify(content), before);
  assert.match(content, /\[STEER\]/);
});


test("immediate mode sends every valid message directly without requiring a marker", () => {
  for (const content of ["Review complete", "[QUEUE] still immediate", "[STEER] urgent", "> quoted content", "Merhaba"]) {
    assert.equal(selectCodexDelivery(content, "immediate"), "steer");
  }
});
