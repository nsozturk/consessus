import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { claim, openPrivate, privatePath, unlinkIfPresent } from "./agent-inbox.mjs";
import { stateHome } from "./home.mjs";
import { isProfile } from "./member-profile.mjs";
import { MAX_FREE_MESSAGES } from "./rooms.mjs";

const { O_RDONLY, O_RDWR, O_APPEND, O_CREAT } = fs.constants;
const roomName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const claimWait = new Int32Array(new SharedArrayBuffer(4));
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = value => typeof value === "string" && value.length > 0;
const absolute = value => nonempty(value) && path.isAbsolute(value);
const timestamp = value => nonempty(value) && Number.isFinite(Date.parse(value));
const memberStates = new Set(["invited", "pending", "member", "left"]);
// How the room talks, set by its lead. A budget only belongs to "free" and never passes the hard cap.
const isDiscussion = value => record(value) && (value.mode === "turns" ? value.maxMessages === undefined
  : value.mode === "free" && (value.maxMessages === undefined
    || (Number.isInteger(value.maxMessages) && value.maxMessages >= 1 && value.maxMessages <= MAX_FREE_MESSAGES)));

function isRoom(room) {
  return record(room) && nonempty(room.room) && roomName.test(room.room) && absolute(room.project)
    && record(room.controller) && nonempty(room.controller.address) && nonempty(room.controller.sessionId)
    && Number.isSafeInteger(room.controller.pid) && room.controller.pid > 0
    && nonempty(room.initiator) && timestamp(room.ts) && Array.isArray(room.members)
    // Both are absent in rooms written before a room had a lead. Whether the lead is an eligible member is checked on use.
    && (room.lead === undefined || nonempty(room.lead)) && (room.discussion === undefined || isDiscussion(room.discussion))
    && room.members.every(member => record(member) && nonempty(member.id) && nonempty(member.kind)
      // A chat attached from another app's list has no socket or process of its own.
      && (member.transport === "app" ? nonempty(member.sessionId) && member.address === undefined && member.pid === undefined
        : member.transport === undefined && nonempty(member.address) && Number.isSafeInteger(member.pid) && member.pid > 0)
      && absolute(member.cwd) && memberStates.has(member.state) && timestamp(member.ts)
      // Both are absent in rooms written before members had profiles. A profile is another app's data.
      && (member.profile === undefined || isProfile(member.profile))
      && (member.rosterStamp === undefined || (typeof member.rosterStamp === "string" && /^[0-9a-f]{16}$/.test(member.rosterStamp))));
}

function isApproval(approval) {
  return record(approval) && absolute(approval.project) && nonempty(approval.identityId);
}

function requireName(name) {
  if (!nonempty(name) || !roomName.test(name)) throw new Error("Invalid room name");
  return name;
}

function readBytes(filename) {
  let fd;
  try { fd = openPrivate(filename, O_RDONLY); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  try { return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}

function parseJson(bytes, filename) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`Invalid room data: ${filename}`); }
}

function syncDirectory(dirname) {
  const fd = fs.openSync(dirname, O_RDONLY);
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function writeJson(filename, data) {
  const previous = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (previous) privatePath(previous, "file", filename);
  const dirname = path.dirname(filename);
  const temporary = path.join(dirname, `.room-write-${randomUUID()}`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(data) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    syncDirectory(dirname);
  } finally { unlinkIfPresent(temporary); }
}

function eventFields(value) {
  if (!record(value)) throw new Error("Invalid room event metadata");
  return Object.fromEntries(["memberId", "state", "status", "reason", "messageId"].flatMap(
    field => typeof value[field] === "string" ? [[field, value[field]]] : [],
  ));
}

function journalEvent(event, ts) {
  if (!nonempty(event?.event) || !timestamp(ts)) throw new Error("Invalid room event");
  const row = { event: event.event, ...eventFields(event), ts };
  if (event.receipts !== undefined) {
    if (!Array.isArray(event.receipts)) throw new Error("Invalid room event receipts");
    row.receipts = event.receipts.map(eventFields);
  }
  return row;
}

function journalOffset(filename) {
  const bytes = readBytes(filename);
  if (!bytes?.length) return 0;
  if (bytes.at(-1) !== 10) throw new Error(`Invalid room journal: ${filename}`);
  // shortcut: validate the journal on append for small rooms, add journal indexing if logs grow large.
  for (const line of bytes.toString("utf8").slice(0, -1).split("\n")) {
    const row = parseJson(line, filename);
    journalEvent(row, row?.ts);
  }
  return bytes.length;
}

function applyJournal(filename, offset, rows) {
  const bytes = Buffer.from(rows.map(row => JSON.stringify(journalEvent(row, row.ts)) + "\n").join(""));
  const fd = openPrivate(filename, O_RDWR | O_APPEND | (offset === 0 ? O_CREAT : 0));
  try {
    // A dead writer can leave a prefix of the committed append. Verify it before retrying the remainder.
    const length = fs.fstatSync(fd).size - offset;
    if (length < 0 || length > bytes.length) throw new Error(`Invalid room journal offset: ${filename}`);
    const written = Buffer.alloc(length);
    if (fs.readSync(fd, written, 0, length, offset) !== length || !written.equals(bytes.subarray(0, length))) {
      throw new Error(`Conflicting room journal append: ${filename}`);
    }
    if (length < bytes.length) fs.writeFileSync(fd, bytes.subarray(length));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function openRoomStore() {
  const home = stateHome();
  const rooms = path.join(home, "rooms");
  const approvedFile = path.join(home, "approved.json");
  const pendingFile = path.join(home, ".room-transaction.json");
  const lock = path.join(home, "room-store.lock");
  const roomFile = name => path.join(rooms, `${requireName(name)}.json`);
  const journalFile = name => path.join(rooms, `${requireName(name)}.jsonl`);

  function ensureDirectories() {
    for (const dirname of [home, rooms]) {
      fs.mkdirSync(dirname, { recursive: true, mode: 0o700 });
      privatePath(fs.lstatSync(dirname), "directory", dirname);
    }
  }

  function readRoom(name) {
    const filename = roomFile(name);
    const bytes = readBytes(filename);
    if (bytes === undefined) return undefined;
    const room = parseJson(bytes, filename);
    if (!isRoom(room) || room.room !== name) throw new Error(`Invalid room state: ${filename}`);
    return room;
  }

  function readApprovals() {
    const bytes = readBytes(approvedFile);
    if (bytes === undefined) return [];
    const approvals = parseJson(bytes, approvedFile);
    if (!Array.isArray(approvals) || !approvals.every(isApproval)) throw new Error("Invalid room approvals");
    return approvals;
  }

  function applyPending(changes) {
    if (!record(changes) || !Array.isArray(changes.rooms) || !changes.rooms.every(isRoom)
      || (changes.approvals !== null && (!Array.isArray(changes.approvals) || !changes.approvals.every(isApproval)))
      || !Array.isArray(changes.journals)) throw new Error("Invalid room transaction");
    for (const { name, offset, rows } of changes.journals) {
      requireName(name);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(rows) || !rows.length) {
        throw new Error("Invalid room transaction journal");
      }
      rows.forEach(row => journalEvent(row, row?.ts));
    }
    for (const room of changes.rooms) writeJson(roomFile(room.room), room);
    if (changes.approvals !== null) writeJson(approvedFile, changes.approvals);
    for (const { name, offset, rows } of changes.journals) applyJournal(journalFile(name), offset, rows);
    syncDirectory(rooms);
    fs.unlinkSync(pendingFile);
    syncDirectory(home);
  }

  function transact(callback) {
    ensureDirectories();
    const existing = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (existing) privatePath(existing, "directory", lock);
    const deadline = performance.now() + 3000;
    const release = claim(home, "room-store", () => {
      if (performance.now() >= deadline) throw new Error("Timed out waiting for the room store");
      Atomics.wait(claimWait, 0, 0, 10);
    });
    let active = true;
    const requireActive = () => { if (!active) throw new Error("Room transaction is closed"); };
    try {
      const pending = readBytes(pendingFile);
      if (pending !== undefined) applyPending(parseJson(pending, pendingFile));
      const saved = new Map();
      const events = new Map();
      let approvals;
      let approvalChanged = false;
      const tx = {
        readRoom(name) {
          requireActive();
          return saved.has(name) ? structuredClone(saved.get(name)) : readRoom(name);
        },
        listRooms() {
          requireActive();
          const stored = fs.readdirSync(rooms).filter(name => name.endsWith(".json"))
            .map(name => name.slice(0, -5));
          return [...new Set([...stored, ...saved.keys()])].sort().map(tx.readRoom).filter(Boolean);
        },
        saveRoom(value) {
          requireActive();
          const room = JSON.parse(JSON.stringify(value));
          if (!isRoom(room)) throw new Error("Invalid room state");
          tx.readRoom(room.room);
          saved.set(room.room, room);
        },
        hasApproval(project, identityId) {
          requireActive();
          if (!isApproval({ project, identityId })) throw new Error("Invalid room approval identity");
          approvals ??= readApprovals();
          return approvals.some(approved => approved.project === project && approved.identityId === identityId);
        },
        approveIdentity(project, identityId) {
          if (tx.hasApproval(project, identityId)) return;
          approvals.push({ project, identityId });
          approvalChanged = true;
        },
        appendEvent(name, entry) {
          requireActive();
          requireName(name);
          const row = journalEvent(entry, new Date().toISOString());
          if (!events.has(name)) events.set(name, []);
          events.get(name).push(row);
        },
      };
      const result = callback(tx);
      active = false;
      if (typeof result?.then === "function") throw new Error("Room transactions must be synchronous");
      if (saved.size || approvalChanged || events.size) {
        const changes = {
          rooms: [...saved.values()],
          approvals: approvalChanged ? approvals : null,
          journals: [...events].map(([name, rows]) => ({ name, rows, offset: journalOffset(journalFile(name)) })),
        };
        writeJson(pendingFile, changes);
        applyPending(changes);
      }
      return result;
    } finally {
      active = false;
      release();
    }
  }

  ensureDirectories();
  return {
    readRoom: name => transact(tx => tx.readRoom(name)),
    listRooms: () => transact(tx => tx.listRooms()),
    transact,
  };
}
