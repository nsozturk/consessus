#!/usr/bin/env node
/**
 * consessus CLI
 * Native Unix Domain Socket peer bridge, inter-agent messaging,
 * and live session streamer for Claude Code and Claude Desktop.
 *
 * Copyright (c) 2026 nsozturk
 * Licensed under the MIT License.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { openAgentInbox, waitForAgentInbox } from "../src/agent-inbox.mjs";
import { openOpencodeDelivery } from "../src/opencode-delivery.mjs";
import { openAntigravityDelivery } from "../src/antigravity-delivery.mjs";
import { checkVersions, formatDoctor } from "../src/doctor.mjs";
import { listSessions, formatSessions } from "../src/sessions.mjs";
import { readProfile } from "../src/member-profile.mjs";
import { watchSessions, formatWatchEvent } from "../src/watch.mjs";
import { sendToSession } from "../src/send-router.mjs";
import { claudeTranscriptMark, confirmClaudeDelivery } from "../src/claude-replies.mjs";
import {
  listLiveSessions,
  resolveTargetSession,
  sendMessageToSession,
  sendControlToSession,
  startPeerAgentDaemon,
  locateTranscriptFile,
  tailTranscript,
  validateSenderMode,
  formatDeliveryReceipt,
  openCodexRelay,
} from "../src/index.mjs";

const VERSION = "1.0.0";

// ANSI Colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";
const BG_CYAN = "\x1b[46m\x1b[30m";

function printHelp() {
  console.log(`
${BOLD}consessus${RESET} v${VERSION}
Native local Unix Domain Socket (UDS) peer bridge & streamer for Claude Code.

${BOLD}USAGE:${RESET}
  consessus <command> [options]

${BOLD}COMMANDS:${RESET}
  ${GREEN}sessions${RESET} [--project <dir>] [--json]  List open sessions of Claude, Codex, Antigravity and OpenCode, with mode and model
  ${GREEN}watch${RESET} [--project <dir>]             Print a line whenever a session appears, goes away or changes state
  ${GREEN}doctor${RESET}                      Compare installed app and CLI versions with the tested ones
  ${CYAN}list${RESET}                                Discover all active Claude Code / Desktop sessions
  ${CYAN}send${RESET} --to <target> --message <text>   Send a cross-session message to a running session
  ${CYAN}stream${RESET} [--to <target>]                Live-tail saved transcript entries and tool calls
  ${CYAN}agent${RESET} --name <name>                  Run a persistent UDS peer daemon Claude can message
  ${CYAN}wait${RESET} --name <name>                   Print the next unread peer frame and exit
  ${CYAN}room${RESET} <command>                       Open a project room, join, approve, send, discuss, assign tasks, or set its lead
  ${CYAN}rename${RESET} --to <target> --name <name>    Live-rename a running session's title

${BOLD}OPTIONS:${RESET}
  ${GREEN}list:${RESET}
    --json                    Output sessions as raw JSON

  ${GREEN}send:${RESET}
    --to <pid|id|name|sock>   Target session identifier
    --message, -m <text>      Message content to send
    --from-name <name>        Sender display name (default: "consessus")
    --to <app>:<session id>   Any app session from 'consessus sessions': claude:, codex:, antigravity: or opencode: plus the id or a unique prefix
    --read [--timeout <s>]    With an app:id target: wait for and print the reply (Antigravity, Codex, the OpenCode CLI service, Claude)
    --from-mode <mode>        Sender policy: "prompting" or "bypass" (recommended)
    --from-address <uds:...>  Running listener address for replies and receipts
    --from-session <id>       Running listener session ID
    --priority <priority>     "next" (default) or "now"
    --raw                     Send as raw user input without XML wrapper

  ${GREEN}stream:${RESET}
    --to <pid|id|name>        Target session (defaults to most recently active)
    --tail <n>                Number of initial lines to replay (default: 5)
    --all                     Replay entire session transcript from start
    --raw-json                Output raw transcript JSON records
    --from-mode <mode>        Declare this sender policy for stdin sends

  ${GREEN}agent:${RESET}
    --name <name>             Agent name shown in Claude's ListPeers (default: "consessus-agent")
    --to <target>             Optionally send an initial message to a session upon start
    --message <text>          Initial message text
    --from-mode <mode>        "prompting" or "bypass"
    --notify-idle             Subscribe to notify_when_idle event on the target session
    --inbox                   Store incoming peer frames in a private inbox for wait
    --opencode-session <id>   With --inbox: also post each message into this OpenCode session (auto = the project's only one)
    --opencode-server <url>   Loopback OpenCode server; default: found on the listener's parent processes
    --antigravity-conversation <id>  With --inbox: also send each message into this open Antigravity conversation (auto = the project's only one)
    --room-control            Read room join/send/leave JSON lines from this listener's own stdin
    --codex-thread <uuid>     Relay selected Claude source into an existing Codex chat
    --relay-db <path>         SQLite journal (default: ./data/raw_consessus.sqlite)
    --relay-routing <mode>    queue (default), hybrid, or immediate (all messages direct)

  ${GREEN}wait:${RESET}
    --name <name>             Peer inbox name
    --timeout <seconds>       Exit 2 silently if no frame arrives
    --json                    Print raw inbox JSON lines
    --all                     Print all currently pending frames

  ${GREEN}room:${RESET}
    open <room> --project <dir> [--require-approval]   Attaches the project's open Codex, Antigravity and OpenCode chats
         [--discussion turns|free [--max-messages <n>]]   How a new room talks (default turns). The opener leads if it is a verified Claude session or an operator terminal
    join [<room>] [--project <dir>] [--from-address <uds> --from-session <id>]
    status <room> | members <room> | approve <room> <id> | deny <room> <id>
    send <room> (--to <id> | --all) --message <text> | leave <room>
    lead <room> <member>      Make a member the room lead. Always allowed from an operator terminal; a member may do it
                              only if it can lead and is the room's opener or the current lead. The lead is a verified
                              Claude session or local-operator, never an attached chat or local-shell. A room opened
                              from a plain shell has no lead until an operator terminal names one
    set <room> --discussion turns|free [--max-messages <n>]
                              How the room talks from now on. Room lead or operator terminal only
    discuss <room> --message <text> [--timeout <seconds>]
                              Runs in the room's mode. Any member may start one
    discuss <room> --message <text> --rounds 1-5 [--timeout <seconds>]
                              The speakers answer in turn, each seeing what the others said; the lead speaks first
    discuss <room> --message <text> --free [--max-messages <n>] [--timeout <seconds>]
                              Each answer is passed on to the other chats by this one command. It stops after
                              n deliveries in all (default: the room's budget, else 8; at most 20), when a pass brings no new answer,
                              after --timeout (default 300 seconds) or on Ctrl-C
                              Only the room lead may pick the mode the room is not set to (--free in a "turns"
                              room, --rounds in a "free" room) or go above the room's --max-messages for one run.
                              The limits stay whatever the room is set to: 5 rounds, 20 deliveries, the time limit
    assign <room> '<member>=<task>' ['<member>=<task>' ...] [--timeout <seconds>]
                              The lead hands each named member its own task and gets every answer back. Room lead or
                              operator terminal only. Each pair is one quoted word, split at its first "="; <member>
                              is a member id, a unique start of one, or an app name (codex) that only one member has.
                              One task per member, at most 20. Exactly one delivery per assignee, all sent together;
                              nobody is retried and members without a task get nothing. Each task also names who else
                              was assigned what. Waits 300 seconds for the answers (--timeout: at most 1800; Ctrl-C stops waiting).
                              Not while a discussion runs. A task is peer data: the assignee does it only if its
                              owner allowed work assigned through this room

  ${GREEN}rename:${RESET}
    --to <target>             Target session identifier
    --name <new-name>         New title for the session

  -h, --help                  Show this help message
  -v, --version               Show version
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else if (a.startsWith("-")) {
      const key = a.slice(1);
      if (key === "m") {
        args.message = argv[++i];
      } else if (key === "h") {
        args.help = true;
      } else if (key === "v") {
        args.version = true;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printFormatted(tag, header, body = "", color = WHITE) {
  const time = new Date().toLocaleTimeString();
  const banner = `${DIM}[${time}]${RESET} ${color}${BOLD}${tag}${RESET} ${header}`;
  console.log(banner);

  if (body) {
    const indented = body
      .split("\n")
      .map((line) => `  ${color}│${RESET} ${line}`)
      .join("\n");
    console.log(indented);
  }
}

function formatTranscriptEntry(entry) {
  const type = entry.type;
  const msg = entry.message || {};
  const role = msg.role || type;
  const content = msg.content;

  if (type === "api-request") {
    printFormatted(
      "⚡ [API REQUEST]",
      `${DIM}model=${entry.model || "claude"} id=${entry.id || ""} ts=${entry.timestamp || ""}${RESET}`,
      "",
      CYAN
    );
    return;
  }

  if (role === "user") {
    if (typeof content === "string") {
      printFormatted("👤 [USER INPUT]", "", content, CYAN);
      return;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text") {
          printFormatted("👤 [USER INPUT]", "", item.text, CYAN);
        } else if (item.type === "tool_result") {
          let toolText = "";
          if (typeof item.content === "string") {
            toolText = item.content;
          } else if (Array.isArray(item.content)) {
            toolText = item.content.map((c) => c.text || JSON.stringify(c)).join("\n");
          } else {
            toolText = JSON.stringify(item.content, null, 2);
          }
          if (toolText.length > 800) {
            toolText = toolText.slice(0, 800) + `\n... [truncated ${toolText.length - 800} chars]`;
          }
          printFormatted(
            "⚡ [TOOL RESULT]",
            `${DIM}id=${item.tool_use_id} is_error=${item.is_error || false}${RESET}`,
            toolText,
            BLUE
          );
        }
      }
      return;
    }
  }

  if (role === "assistant") {
    if (typeof content === "string") {
      printFormatted("🤖 [ASSISTANT]", "", content, GREEN);
      return;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "thinking" && item.thinking && item.thinking.trim()) {
          printFormatted("🧠 [THINKING]", `${DIM}(Internal reasoning)${RESET}`, item.thinking, MAGENTA);
        } else if (item.type === "text") {
          printFormatted("🤖 [ASSISTANT]", "", item.text, GREEN);
        } else if (item.type === "tool_use") {
          const inputStr = JSON.stringify(item.input, null, 2);
          printFormatted(
            `🛠️  [TOOL CALL: ${item.name}]`,
            `${DIM}id=${item.id}${RESET}`,
            inputStr,
            YELLOW
          );
        }
      }
      return;
    }
  }

  if (type === "system" && entry.subtype === "stop_hook_summary") {
    printFormatted("🛑 [TURN COMPLETE]", `Hooks executed: ${entry.hookCount || 0}`, "", DIM);
  }
}

async function handleList(args) {
  const sessions = await listLiveSessions();
  if (args.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log("No running Claude Code or Claude Desktop sessions found in ~/.claude/sessions/");
    return;
  }
  console.log(`Found ${sessions.length} live Claude Code session(s):\n`);
  for (const s of sessions) {
    const reachable = s.sockReachable ? `${GREEN}READY${RESET}` : `${YELLOW}UNREACHABLE${RESET}`;
    const key = s.hasKey ? `${GREEN}AUTH-KEY-OK${RESET}` : `${DIM}NO-KEY${RESET}`;
    console.log(
      `- PID: ${BOLD}${String(s.pid).padEnd(6)}${RESET} | Status: ${s.status.padEnd(7)} | Sock: ${reachable} | Key: ${key} | Name: ${GREEN}${s.name || "(unnamed)"}${RESET}`
    );
    console.log(`  sessionId: ${DIM}${s.sessionId}${RESET}`);
    console.log(`  cwd:       ${s.cwd}`);
    console.log(`  socket:    ${s.messagingSocketPath}`);
    if (s.bridgeSessionId) console.log(`  bridge:    bridge:${s.bridgeSessionId}`);
    console.log("");
  }
}

async function handleSend(args) {
  const to = args.to || args._[1];
  const message = args.message || args._[2];
  if (!to || !message) {
    console.error("Error: --to and --message are required.\nRun 'consessus --help' for usage.");
    process.exit(1);
  }

  // "app:id" addresses a session of any of the four apps (see `consessus sessions`).
  if (/^(claude|codex|antigravity|opencode):/.test(String(to))) {
    const seconds = args.timeout === undefined ? undefined : Number(args.timeout);
    if (seconds !== undefined && !(seconds > 0)) throw new Error("--timeout takes a number of seconds");
    const result = await sendToSession({ to: String(to), message: String(message), fromName: args["from-name"] || "consessus",
      read: args.read === true, timeoutMs: seconds === undefined ? undefined : seconds * 1000 });
    if (result.warning) console.error(`Note: ${result.warning}`);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failed") process.exitCode = 1;
    return;
  }

  // Mark the session's record before sending, so the receipt can say whether the message was written down.
  let mark;
  try {
    const target = await resolveTargetSession(to);
    if (target?.sessionId && target.cwd) mark = { session: { sessionId: target.sessionId, cwd: target.cwd }, offset: claudeTranscriptMark({ sessionId: target.sessionId, cwd: target.cwd }) };
  } catch {}
  const res = await sendMessageToSession({
    target: to,
    message,
    fromAddress: args["from-address"],
    fromSessionId: args["from-session"],
    fromName: args["from-name"] || "consessus",
    fromMode: args["from-mode"],
    priority: args.priority || "next",
    raw: Boolean(args.raw),
  });

  const receipt = mark ? await confirmClaudeDelivery({ ...mark.session, msgId: res.msgId, offset: mark.offset }) : "unknown";
  console.log(
    `Frame written (msg_id=${res.msgId}) to PID ${res.target.pid} (${res.target.name || res.target.messagingSocketPath}); receipt ${receipt}`
  );
  if (receipt === "unconfirmed") {
    console.error("Note: the session has not recorded the message. It may be held for approval there, or that process is a listener or does not accept peer messages.");
    process.exitCode = 3;
  } else if (receipt === "unknown") {
    console.error("Note: this target keeps no record Consessus can read (a listener, or a socket path), so delivery cannot be confirmed.");
  }
}

async function handleRename(args) {
  const to = args.to || args._[1];
  const name = args.name || args._[2];
  if (!to || !name) {
    console.error("Error: --to and --name are required.\nRun 'consessus --help' for usage.");
    process.exit(1);
  }

  const res = await sendControlToSession({
    target: to,
    action: "rename",
    payload: { name },
  });

  console.log(`Rename frame written for PID ${res.target.pid}: '${name}' (msg_id=${res.msgId}); execution unconfirmed`);
}

async function handleStream(args) {
  if (args["from-mode"] !== undefined) validateSenderMode(args["from-mode"]);
  let targetQuery = args.to || args._[1];

  if (!targetQuery) {
    const sessions = await listLiveSessions();
    if (sessions.length === 0) {
      console.error("No active Claude sessions found. Start a Claude Code session first.");
      process.exit(1);
    }
    targetQuery = String(sessions[0].pid);
    console.log(`Auto-selected latest session: PID ${sessions[0].pid} ('${sessions[0].name || "unnamed"}')`);
  }

  const target = await resolveTargetSession(targetQuery);
  const transcriptPath = locateTranscriptFile(target.sessionId, target.cwd);

  if (!transcriptPath) {
    console.error(`Could not locate transcript file for session ${target.sessionId} in ~/.claude/projects/`);
    process.exit(1);
  }

  console.log(`\n${BOLD}================================================================${RESET}`);
  console.log(`${BG_CYAN}         CLAUDE CODE LIVE STREAM & REVERSE IPC MONITOR          ${RESET}`);
  console.log(`${BOLD}================================================================${RESET}`);
  console.log(`Session PID:     ${CYAN}${target.pid}${RESET}`);
  console.log(`Session ID:      ${CYAN}${target.sessionId}${RESET}`);
  console.log(`Session Name:    ${GREEN}${target.name || "(unnamed)"}${RESET}`);
  console.log(`Directory (cwd): ${target.cwd}`);
  console.log(`Transcript File: ${transcriptPath}`);
  console.log(`Socket Path:     ${target.messagingSocketPath || "(none)"}`);
  console.log(`${DIM}Type text and press Enter to send. Declare --from-mode to report the sender policy.${RESET}`);
  console.log(`${BOLD}----------------------------------------------------------------${RESET}\n`);

  const tailLines = args.all ? 0 : args.tail ? parseInt(args.tail, 10) : 5;
  const showAll = Boolean(args.all);

  const stopTail = await tailTranscript(transcriptPath, {
    tailLines,
    showAll,
    onEntry: (entry) => {
      if (args["raw-json"]) {
        console.log(JSON.stringify(entry));
      } else {
        formatTranscriptEntry(entry);
      }
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      console.log(`\n${DIM}Injecting live into PID ${target.pid}...${RESET}`);
      await sendMessageToSession({
        target,
        message: text,
        fromName: "consessus-stream",
        fromMode: args["from-mode"],
        priority: "next",
        raw: false,
      });
      printFormatted("[FRAME WRITTEN; RECEIPT UNCONFIRMED]", `to PID ${target.pid}`, text, CYAN);
    } catch (err) {
      console.error(`Failed to inject: ${err.message}`);
    }
  });

  const cleanup = () => {
    stopTail();
    rl.close();
    console.log(`\n${DIM}Live stream disconnected.${RESET}`);
    process.exit(0);
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

async function handleAgent(args) {
  if (args.inbox !== undefined && args.inbox !== true) throw new Error("--inbox is a flag");
  if (args.inbox && args["codex-thread"]) throw new Error("--inbox cannot be combined with --codex-thread");
  if (args["room-control"] !== undefined && (args["room-control"] !== true || !args.inbox)) {
    throw new Error("--room-control requires --inbox");
  }
  if (args["relay-routing"] !== undefined && !["queue", "hybrid", "immediate"].includes(args["relay-routing"])) throw new Error("--relay-routing must be queue or hybrid or immediate");
  if (args["relay-routing"] !== undefined && !args["codex-thread"]) throw new Error("--relay-routing requires --codex-thread");
  if (args["from-mode"] !== undefined || args["codex-thread"]) validateSenderMode(args["from-mode"]);
  let relay;
  if (args["codex-thread"]) {
    if (typeof args["codex-thread"] !== "string" || typeof args.to !== "string") {
      throw new Error("--codex-thread requires a thread UUID and explicit --to Claude source");
    }
    const target = await resolveTargetSession(args.to);
    relay = await openCodexRelay({
      threadId: args["codex-thread"], target,
      dbPath: path.resolve(args["relay-db"] || path.join(process.cwd(), "data", "raw_consessus.sqlite")),
      routing: args["relay-routing"] ?? "queue",
    });
    process.once("exit", () => relay.close());
  }
  if ((args["opencode-session"] !== undefined || args["opencode-server"] !== undefined)
    && (!args.inbox || typeof args["opencode-session"] !== "string")) {
    throw new Error("--opencode-session <id|auto> requires --inbox; --opencode-server requires --opencode-session");
  }
  if (args["antigravity-conversation"] !== undefined && (!args.inbox || typeof args["antigravity-conversation"] !== "string")) {
    throw new Error("--antigravity-conversation <id|auto> requires --inbox");
  }
  const antigravity = args["antigravity-conversation"]
    ? await openAntigravityDelivery({ conversation: args["antigravity-conversation"] }) : undefined;
  const opencode = args["opencode-session"]
    ? await openOpencodeDelivery({ server: args["opencode-server"], session: args["opencode-session"] }) : undefined;
  let lastReceipt;
  const agentName = args.name || "consessus-agent";
  const inbox = args.inbox ? openAgentInbox(agentName) : undefined;
  if (inbox) process.once("exit", inbox.close);

  const daemon = await startPeerAgentDaemon({
    name: agentName,
    requireAuth: Boolean(relay || args["room-control"]),
    onFrame: inbox ? (frame, rawLine) => {
      // The inbox is the durable copy. A failed post leaves the message there for wait.
      inbox.append(frame, rawLine);
      if (opencode) void opencode.deliver(frame).then(result => {
        if (result.status !== "skipped") console.log(`[consessus] OpenCode delivery ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      });
      if (antigravity) void antigravity.deliver(frame).then(result => {
        if (result.status !== "skipped") console.log(`[consessus] Antigravity delivery ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      });
    } : relay ? (frame, rawLine) => {
      void relay.receive(frame, rawLine).catch((error) => console.error("[consessus] Relay error:", error.message));
    } : undefined,
    onMessage: inbox ? undefined : (frame) => {
      console.log(`\n${GREEN}${BOLD}[INBOUND MESSAGE]${RESET} (${new Date().toLocaleTimeString()}):`);
      console.log(JSON.stringify(frame, null, 2));
    },
    onControl: inbox ? undefined : (frame) => {
      console.log(`\n${YELLOW}${BOLD}[INBOUND CONTROL]${RESET} (${new Date().toLocaleTimeString()}):`);
      console.log(JSON.stringify(frame, null, 2));
      const receipt = formatDeliveryReceipt(frame);
      if (receipt) { lastReceipt = frame; console.log(receipt); }
    },
  }).catch((error) => { inbox?.close(); relay?.close(); throw error; });

  console.log(`✓ Registered live peer agent '${BOLD}${daemon.name}${RESET}' at ${daemon.address} (PID ${daemon.pid})`);
  console.log(`Running Claude Code sessions can now see '${daemon.name}' via ListPeers and message it via SendMessage.`);

  if (args.to && args.message) {
    const res = await sendMessageToSession({
      target: args.to,
      message: args.message,
      fromAddress: daemon.address,
      fromSessionId: daemon.sessionId,
      fromName: daemon.name,
      fromMode: args["from-mode"],
      priority: args.priority || "next",
    });
    const status = lastReceipt?.orig_msg_id === res.msgId ? lastReceipt.status : res.receipt;
    console.log(`Frame written (msg_id=${res.msgId}) to PID ${res.target.pid}; receipt ${status}`);

    if (args["notify-idle"]) {
      const sub = await sendControlToSession({
        target: res.target,
        action: "notify_when_idle",
        payload: {
          from: daemon.address,
          ...(args["from-mode"] ? { from_mode: args["from-mode"] } : {}),
        },
      });
      console.log(`✓ Subscribed to notify_when_idle on PID ${res.target.pid} (msg_id=${sub.msgId})`);
    }
  }

  console.log(`${DIM}Listening for incoming peer messages... (Press Ctrl+C to stop)${RESET}`);
  if (args["room-control"]) {
    const [{ readRoomControl }, { handleRoomCommand }] = await Promise.all([
      import("../src/room-control.mjs"), import("../src/room-cli.mjs"),
    ]);
    await readRoomControl({
      input: process.stdin, endpoint: { ...daemon, fromMode: args["from-mode"] }, dispatch: handleRoomCommand,
      reportError: line => console.error(`[consessus] ${line}`),
    });
  }
}

function writeWaitOutput(text) {
  return new Promise((resolve, reject) => {
    process.stdout.once("error", reject);
    process.stdout.write(text, (err) => {
      if (err) reject(err);
      else {
        process.stdout.off("error", reject);
        resolve();
      }
    });
  });
}

async function handleWait(args) {
  const timeout = args.timeout;
  const seconds = timeout === undefined ? undefined : Number(timeout);
  if (timeout !== undefined && (typeof timeout !== "string" || !timeout.trim()
    || !Number.isFinite(seconds * 1000) || seconds < 0)) {
    throw new Error("--timeout must be a nonnegative number of seconds");
  }
  process.exitCode = await waitForAgentInbox({ name: args.name, seconds, all: args.all === true,
    json: args.json === true, write: writeWaitOutput });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    return;
  }

  if (args.help || args._.length === 0) {
    printHelp();
    return;
  }

  const cmd = args._[0];

  switch (cmd) {
    case "sessions": {
      const found = await listSessions({ project: typeof args.project === "string" ? args.project : undefined, profileOf: readProfile });
      process.stdout.write(args.json ? JSON.stringify(found, null, 2) + "\n" : formatSessions(found));
      break;
    }
    case "watch": {
      const stop = new AbortController();
      process.once("SIGINT", () => stop.abort());
      process.once("SIGTERM", () => stop.abort());
      await watchSessions({ project: typeof args.project === "string" ? args.project : undefined, signal: stop.signal,
        onChange: event => process.stdout.write(formatWatchEvent(event) + "\n") });
      break;
    }
    case "doctor":
      process.stdout.write(formatDoctor(await checkVersions()));
      break;
    case "list":
    case "ls":
      await handleList(args);
      break;
    case "send":
    case "msg":
      await handleSend(args);
      break;
    case "stream":
    case "monitor":
    case "tail":
      await handleStream(args);
      break;
    case "agent":
    case "daemon":
    case "peer":
      await handleAgent(args);
      break;
    case "wait":
      await handleWait(args);
      break;
    case "room": {
      const { handleRoomCommand } = await import("../src/room-cli.mjs");
      await handleRoomCommand(args);
      break;
    }
    case "rename":
      await handleRename(args);
      break;
    default:
      console.error(`Unknown command: '${cmd}'. Run 'consessus --help' for available commands.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${YELLOW}Error:${RESET} ${err.message}`);
  process.exit(1);
});
