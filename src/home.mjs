import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let told = false;
const once = line => { if (!told) { told = true; console.error(line); } };

// Consessus was called claude-peer. State written under the old name stays where it is:
// it is used until a Consessus directory exists, and it is never moved or deleted.
export function stateHome({ env = process.env, homedir = os.homedir(), warn = once } = {}) {
  const chosen = env.CONSESSUS_HOME || env.CLAUDE_PEER_HOME;
  if (chosen) {
    if (!path.isAbsolute(chosen)) throw new Error("CONSESSUS_HOME must be an absolute path");
    return chosen;
  }
  const current = path.join(homedir, ".consessus"), old = path.join(homedir, ".claude-peer");
  if (!fs.existsSync(current) && fs.existsSync(old)) {
    warn(`[consessus] Using the existing state directory ${old}. Create ${current} to start fresh.`);
    return old;
  }
  return current;
}
