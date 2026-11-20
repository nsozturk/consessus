import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { listSessions, plainText } from "./sessions.mjs";

const key = row => `${row.app}\0${row.id}`;

const untilAbort = (promise, signal) => !signal ? promise : new Promise((resolve, reject) => {
  const stop = () => resolve(undefined);
  signal.addEventListener("abort", stop, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
});

// Polls listSessions and calls onChange once per change. The first poll is the baseline and reports nothing.
export async function watchSessions({ project, intervalMs = 2000, sources, onChange, signal } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= 2 ** 31) throw new RangeError("intervalMs must be a positive number below 2^31");
  if (project !== undefined) fs.realpathSync.native(project);
  let known;
  while (!signal?.aborted) {
    let found;
    try { found = await untilAbort(listSessions({ project, sources }), signal); } catch {}
    if (signal?.aborted) return;
    if (found) {
      const next = new Map(found.sessions.map(row => [key(row), row]));
      // An app that could not be asked keeps its last sessions, so one failed poll is not reported as everything gone.
      const down = new Set(found.unavailable.map(entry => entry.app));
      if (known) {
        for (const [id, row] of known) if (down.has(row.app)) next.set(id, row);
        const t = new Date().toISOString();
        const event = (type, row, change) => ({ t, type, app: row.app, id: row.id, path: row.path ?? null, ...change });
        for (const [id, row] of next) {
          const before = known.get(id);
          if (!before) onChange(event("appeared", row, { to: row.status }));
          else if (before.status !== row.status) onChange(event("status", row, { from: before.status, to: row.status }));
        }
        for (const [id, row] of known) if (!next.has(id)) onChange(event("gone", row, { from: row.status }));
      }
      known = next;
    }
    try { await sleep(intervalMs, undefined, { signal }); } catch { return; }
  }
}

export function formatWatchEvent({ t, type, app, id, path, from, to }) {
  const change = type === "status" ? `${plainText(from)} -> ${plainText(to)}` : plainText(type === "gone" ? from : to);
  return [plainText(t), plainText(type).padEnd(8), plainText(app), plainText(id), change, plainText(path ?? "-")].join(" ");
}
