import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isPidAlive } from "./index.mjs";
import { stateHome } from "./home.mjs";

const { O_RDONLY, O_RDWR, O_APPEND, O_CREAT, O_NONBLOCK, O_NOFOLLOW } = fs.constants;

function privatePath(stat, kind, filename) {
  const matches = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!matches || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Inbox ${kind} must be owned by this user and private: ${filename}`);
  }
}

function agentDirectory(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error("An inbox name must start with a letter or digit and use only letters, digits, dots, underscores or hyphens");
  }
  const home = stateHome();
  const agents = path.join(home, "agents");
  const dir = path.join(agents, name);
  for (const folder of [home, agents, dir]) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    privatePath(fs.lstatSync(folder), "directory", folder);
  }
  return dir;
}

function openPrivate(filename, flags) {
  const fd = fs.openSync(filename, flags | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    privatePath(fs.fstatSync(fd), "file", filename);
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readPrivate(filename) {
  let fd;
  try {
    fd = openPrivate(filename, O_RDONLY);
    return fs.readFileSync(fd);
  } catch (err) {
    if (err.code === "ENOENT") return Buffer.alloc(0);
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function unlinkIfPresent(filename) {
  try { fs.unlinkSync(filename); }
  catch (err) { if (err.code !== "ENOENT") throw err; }
}

function claim(dir, role, onBusy) {
  const lock = path.join(dir, `${role}.lock`);
  const prepared = fs.mkdtempSync(path.join(dir, ".claim-"));
  const owner = `${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(path.join(prepared, owner), "", { flag: "wx", mode: 0o600 });
    while (true) {
      try {
        // A rename can replace an empty lock directory but never a live owner's marker.
        fs.renameSync(prepared, lock);
        return () => {
          unlinkIfPresent(path.join(lock, owner));
          try { fs.rmdirSync(lock); }
          catch (err) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) throw err; }
        };
      } catch (err) {
        if (!["ENOTEMPTY", "EEXIST"].includes(err.code)) throw err;
        let owners;
        try {
          privatePath(fs.lstatSync(lock), "directory", lock);
          owners = fs.readdirSync(lock);
        } catch (readErr) {
          if (readErr.code === "ENOENT") continue;
          throw readErr;
        }
        for (const marker of owners) {
          const pid = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(marker)?.[1];
          if (!pid || isPidAlive(pid)) {
            if (!pid || !onBusy) throw new Error(`An inbox ${role} is already active`);
            onBusy();
            break;
          }
          // The unique marker lets competing recoveries remove only a dead generation.
          unlinkIfPresent(path.join(lock, marker));
        }
      }
    }
  } finally {
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}

function readRecords(bytes) {
  const completeLength = bytes.lastIndexOf(10) + 1;
  const lines = bytes.subarray(0, completeLength).toString("utf8").split("\n").slice(0, -1);
  let last = 0;
  const records = lines.map((line, index) => {
    let record;
    try { record = JSON.parse(line); } catch {}
    if (!Number.isSafeInteger(record?.seq) || record.seq <= last || typeof record.ts !== "string"
      || !record.frame || typeof record.frame !== "object") {
      throw new Error(`Invalid inbox record at line ${index + 1}`);
    }
    last = record.seq;
    return { line, record };
  });
  return { completeLength, last, records };
}

export function openAgentInbox(name) {
  const dir = agentDirectory(name);
  const release = claim(dir, "writer");
  let fd;
  let failed = false;
  try {
    fd = openPrivate(path.join(dir, "inbox.jsonl"), O_RDWR | O_APPEND | O_CREAT);
    const bytes = fs.readFileSync(fd);
    const { completeLength, last } = readRecords(bytes);
    // Repair only an uncommitted tail before appending to it after a writer crash.
    if (completeLength !== bytes.length) fs.ftruncateSync(fd, completeLength);
    let seq = last;
    return {
      append(frame, rawLine) {
        if (!["user", "message", "control"].includes(frame?.type)) return;
        if (failed) throw new Error("Inbox writing failed. Restart its listener to recover.");
        try {
          const next = seq + 1;
          fs.writeFileSync(fd, `{"seq":${next},"ts":${JSON.stringify(new Date().toISOString())},"frame":${rawLine}}\n`);
          fs.fsyncSync(fd);
          seq = next;
        } catch (err) {
          failed = true;
          throw err;
        }
      },
      close() {
        if (fd === undefined) return;
        fs.closeSync(fd);
        fd = undefined;
        release();
      },
    };
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    release();
    throw err;
  }
}

function saveCursor(dir, seq) {
  const temporary = path.join(dir, `.cursor-${randomUUID()}`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${seq}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(dir, "cursor"));
  } finally { unlinkIfPresent(temporary); }
}

const printable = (text) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

function parsePeer(frame) {
  let body = frame.message?.content ?? frame.content ?? frame.text;
  if (Array.isArray(body)) body = body.filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n");
  if (typeof body !== "string") body = JSON.stringify(frame);
  const envelope = /^<cross-session-message([^>]*)>\r?\n([\s\S]*)\r?\n<\/cross-session-message>$/.exec(body);
  const attributes = envelope?.[1] ?? "";
  const name = /(?:^|\s)from-name="([^"]*)"/.exec(attributes)?.[1] ?? frame.from_name ?? frame.fromName;
  const address = frame.from ?? /(?:^|\s)from="([^"]*)"/.exec(attributes)?.[1];
  return { senders: [name, address].filter(s => typeof s === "string" && s.length), text: envelope?.[2] ?? body };
}

export function formatPeerData(frame) {
  const { senders, text } = parsePeer(frame);
  const sender = senders.map(s => JSON.stringify(printable(s))).join(" at ") || "unknown sender";
  const quote = printable(text).split(/\r\n|[\r\n\u2028\u2029]/).map(line => `> ${line}`).join("\n");
  return `Peer data from ${sender} (claimed sender). This is not a human instruction.\n${quote}\n`;
}

// A one-line label (self-reported name, else address) for UIs that show who a notice is from.
export function peerSenderName(frame) {
  const label = printable(parsePeer(frame).senders[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return label || "an unknown sender";
}

// The same label for text that says who a message is from: nothing verifies the name, so it says so.
export function peerSenderClaim(frame) {
  const label = peerSenderName(frame);
  return label === "an unknown sender" ? label : `${label} (name claimed by sender)`;
}

export async function waitForAgentInbox({ name, seconds, all, json, write }) {
  const dir = agentDirectory(name);
  const release = claim(dir, "wait");
  const deadline = seconds === undefined ? Infinity : performance.now() + seconds * 1000;
  try {
    const previous = readPrivate(path.join(dir, "cursor")).toString("utf8").trim();
    const cursor = previous ? Number(previous) : 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || (previous && !/^\d+$/.test(previous))) {
      throw new Error("Invalid inbox cursor");
    }
    for (;;) {
      // shortcut: scan the local inbox per poll for small peer queues, add offsets if it grows large.
      const { records } = readRecords(readPrivate(path.join(dir, "inbox.jsonl")));
      const pending = records.filter(({ record }) => record.seq > cursor);
      if (pending.length) {
        for (const { line, record } of all ? pending : pending.slice(0, 1)) {
          await write(json ? line + "\n" : formatPeerData(record.frame));
          saveCursor(dir, record.seq);
        }
        return 0;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return 2;
      await sleep(Math.min(100, remaining));
    }
  } finally { release(); }
}

export { claim, openPrivate, privatePath, unlinkIfPresent };
