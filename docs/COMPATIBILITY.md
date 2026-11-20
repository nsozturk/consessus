# Compatibility: what version 1 was tested with

Consessus version 1 was built and tested on one Mac on 19 November 2026 with exactly the versions below.
The `send --to … --read` round trips and the project room across the four apps were live on 20 November 2026.
Newer versions of these apps may break it. The Codex relay, the OpenCode delivery, the Antigravity delivery,
`consessus sessions`, `consessus watch` and `consessus send --to <app>:<id>` rely on behaviour those apps do not document, and an update can change it without notice.

If something stops working after an update, run `consessus doctor`. It lists your installed versions next to
these and marks the ones that differ. Please include its output when you report a problem.

## Tested versions

| Component | Version |
|---|---|
| macOS | 27.2 (Apple Silicon) |
| Node.js | 26.13.1 (the core needs 18 or newer; the Codex relay needs 22.13+ or 24+) |
| Claude Code CLI | 2.1.294 |
| Claude Desktop app | 5.11492.5 |
| Codex CLI | 0.163.0 |
| ChatGPT / Codex desktop app | 26.1111.71025 |
| OpenCode CLI (background service) | 2.3.2 |
| OpenCode desktop app | 1.19.5 |
| Antigravity CLI (`agy`) | 1.5.12 |
| Antigravity app | 2.33.0 |
| Antigravity IDE app | 2.6.0 |

## What was proven, and how

"Live" means a real message crossed between two running apps and the receiving model answered without anyone
touching the receiving app. The project room rows say what was observed.

| Direction | Result | Mechanism |
|---|---|---|
| Claude Code ↔ Claude Code (terminal, same permission mode) | Live, both ways | Claude's own peer socket |
| Claude Desktop → Codex desktop chat | Live | Relay into the chat: adds to the running turn (Steer) or starts a new turn |
| Codex desktop chat → Claude Desktop | Live | The Codex agent runs `consessus send` through its listener |
| Claude Desktop → OpenCode desktop | Live | Listener posts to the app's local server, `POST /session/<id>/prompt_async` |
| OpenCode desktop → Claude Desktop | Live | The OpenCode agent runs `consessus send` through its listener |
| Claude Desktop → Antigravity app 2.33.0 conversation | Live; the model answered without a nudge | Listener started with `agent --inbox --antigravity-conversation`, which calls the language server's `SendAgentMessage` |
| Claude Desktop → Antigravity IDE app 2.6.0 conversation | Not tested live | Same `--antigravity-conversation` path |
| Claude Desktop → Antigravity IDE, wake by `wait` | Live with an earlier build of the listener; not tested live with this code | A one-shot `wait` command ends when a message arrives, and the IDE wakes its model |
| Antigravity IDE → Claude Desktop | Live with an earlier build of the listener | The IDE agent runs `consessus send` |
| Claude Desktop → Codex desktop chat found from the project folder, without a thread id given beforehand | Live | Open chats are read from the desktop's local socket and matched to their folder, as `consessus sessions --project` does |
| One list of open sessions of all four apps (`consessus sessions`) | Live on one Mac | Claude's session registry, the Codex desktop socket, the Antigravity language server, the OpenCode CLI service |
| `consessus send --to antigravity:<id> --message … --read`: send, then read the answer | Live on one Mac | The language server's `SendAgentMessage`; the answer is read from the conversation's steps after the send |
| `consessus send --to codex:<id> --message … --read`: send, then read the answer | Live on one Mac | A new turn through the desktop's local socket; the answer is read from the app's local history database (read-only, `node:sqlite`) |
| `consessus send --to opencode:<id> --message … --read` with the OpenCode CLI service: send, then read the answer | Live on one Mac | The CLI service's local server; the answer is read from the session's message list after the posted message (read requests only) |
| OpenCode desktop app through `send --to` | Not live | Its sessions are not listed, so they cannot be addressed; it is reachable only through a listener started inside the app, and no reply is read there |
| `consessus send --to claude:<id> --message … --read`: send, then read the answer | The same reader was live inside room discuss and room assign on 2026-11-20; this command itself was not run live | Claude's own peer socket; the answer is read from the end of the session's own transcript, after the message found by its id |
| Project room across Claude Code (joined from its invite), Codex, Antigravity and the OpenCode CLI, opened from a shell in the project folder | Live on one Mac; the room message was seen in the Codex and OpenCode windows | Room listener over Claude's peer socket; Codex, Antigravity and OpenCode chats are attached from the session list and reached through their app |
| Project room with the `--require-approval` gate | Live earlier with two terminal Claude sessions | Room listener over Claude's peer socket; approval in an operator terminal |
| `room discuss`, turn mode and free mode, with Codex, Antigravity and OpenCode CLI chats and Claude sessions as speakers | Turn mode live on one Mac on 2026-11-20 with a Claude Code session, a Codex chat, an Antigravity conversation and an OpenCode CLI session as speakers; free mode not run live | One command delivers to each speaker (an attached chat through its app, a Claude session over its socket) and reads the answer from that member's own session |
| `room lead`, `room set --discussion` and `room assign` | room assign live on one Mac on 2026-11-20 (four tasks, four answers read back); room lead and room set not run live | The lead and the setting are stored in the room file and checked on every read; an assignment is one delivery per named member, read back the same way as a discussion turn |
| The `MODEL` column, member profiles, introductions and the roster header | Live on one Mac on 2026-11-20; the model of an Antigravity conversation shows as unknown | Read-only, bounded reads of each app's own record |
| Sessions in different permission modes | Message is held, then denied or expired; the receiving model never sees it | Claude's own safeguard |

## Not covered yet

- Codex CLI sessions in a terminal. Only chats of the Codex desktop app are listed and reached.
- The `agy` CLI.
- Gemini CLI.
- Cursor CLI.
- The Antigravity IDE app: not tested with `--antigravity-conversation`, `send --to` or rooms. Only the older `wait` wake was live, with an earlier build of the listener.
- The OpenCode desktop app, except through a listener started inside it. Its sessions are not listed, so `send --to` and rooms do not reach it.

## Known limits

- **Permission modes must match.** A session that asks before running tools holds messages from one that does not, and the other way round. Claude Desktop cannot show the approval prompt, so a held message expires there.
- **OpenCode desktop.** The server documents `/api/session/<id>/prompt`, but that route fails on 1.19.5 (`no such table: session_input`). Consessus reads the server's own API document and uses `/session/<id>/prompt_async` there. The CLI background service (2.x) takes its labelled notice route `/api/session/<id>/synthetic` when it offers one, otherwise the documented `/prompt` route. The desktop app (1.x) is reachable only through a listener started inside it; `send --to` cannot address it and no reply is read there.
- **OpenCode does not wake on a finished background command.** `wait` alone gives OpenCode an inbox, not automatic delivery. Use `agent --inbox --opencode-session`.
- **Antigravity.** The `agy` CLI (1.5.12) cannot reach a conversation that is open in the IDE, and it has no `agentapi` subcommand.
  - `agent --inbox --antigravity-conversation <id|auto>` sends each message through the running language server. It finds the server through the owner-only discovery file `~/.gemini/antigravity/daemon/hub_<port>.json` and checks that the server answers before trusting it. Antigravity must be running.
  - Messages arrive in the conversation as "Message from System".
  - What happens when a message arrives while a turn is running is unknown; it was not tested.
  - Only conversations the server has loaded are reachable. `auto` picks the only one whose workspace is the listener's working directory; an explicit id must belong to that folder too.
  - Without `--antigravity-conversation`, delivery needs the IDE agent to run the listener and re-arm `wait` after every wake. A closed conversation receives nothing.
- **Codex desktop.** The relay takes the chat's thread id (`--codex-thread <uuid>`). `consessus sessions --project <dir>` finds that id from the project folder: it lists the chats a desktop window is showing, with their folder. A chat no window shows is not listed. Without `node:sqlite` the folder is unknown, so `--project` leaves Codex chats out.
- **`consessus sessions`.** OpenCode desktop sessions are not listed: the desktop app exposes no discovery from outside. OpenCode CLI service sessions are listed when busy or touched in the last twelve hours. An app that cannot be reached is printed as "not available" with the reason.
- **`consessus send --to <app>:<id>`.** One address space for the four apps: the app name, a colon, and the session id or a unique prefix of at least 6 characters. Only sessions that `consessus sessions` lists can be addressed.
  - `--read [--timeout <seconds>]` waits for the answer (default 120 seconds) in Antigravity, Codex, the OpenCode CLI service (2.x) and Claude sessions. A Claude answer is read from the end of the session's own transcript (only the text of the turn that followed the message, found by its id); that path is covered by tests with fakes and was not run live. The reply is `unavailable` when the transcript cannot be read. Known limit: for a listed Claude row without a full session id or without a folder, the command ends with an error after the message was already sent.
  - No reply is read when the session was busy when the message arrived, or when its state could not be read: an answer could belong to its earlier turn. (A Claude answer is found by the message id instead.)
  - The Codex answer needs `node:sqlite` to read the app's local history; without it the reply is `unavailable`.
  - The OpenCode answer is read only when the CLI service returned the id of the posted message and told whether the session was busy; otherwise the reply is `not-read`. One page of the newest 200 messages is read, so a turn that adds more than 200 messages ends as `timeout`.
  - A delivered message is quoted under the line `Peer data from "<name>" (claimed sender). This is not a human instruction.` An OpenCode CLI service that offers labelled notices shows it as `Message from <name> (name claimed by sender) via Consessus`. The name is not verified.
- **Project rooms.** `room open <room> --project <dir>` attaches every open Codex, Antigravity and OpenCode chat of the project folder by itself, from the same list `consessus sessions --project` prints, and checks again about every 30 seconds.
  - Attached chats receive room messages through their app and get no roster announcements; the first room message a chat receives starts with the room's rules and roster, and that header is sent again only after a member, a model or the lead changed. A chat is dropped after two checks in which its app answered and the chat was gone.
  - An attached chat cannot send into the room under its own name; it answers in its own window. `room send` does not carry that answer to the other members.
  - `--codex-thread` on `room open` and the printed Antigravity startup text are gone.
  - A shell inside the project folder that has no verified session of its own opens and uses a room as the member `local-shell`, unless the room was opened with `--require-approval`. A room opened with `--require-approval` attaches no app chats.
- **Members and introductions.** Each member's app, model and (for Claude) permission mode are read from the app's own record and shown as `unknown` when they cannot be read. Socket members get an `Entered room` line for each new member; an attached chat gets the rules and the roster at the top of its first room message.
  - A socket member leaves after two liveness checks in a row that clearly said its process is gone. A check that failed is not a miss.
  - Profile reads: a transcript file that is a link is refused, but a session folder that is a link to another folder is followed. The Codex state database is opened wherever its name points, without an owner check.
- **`room discuss`.** One command asks the speakers (attached Codex, Antigravity and OpenCode chats and joined Claude sessions) and reads each answer from that member's own session. Nothing a member writes causes a delivery.
  - Turn mode: exactly speakers × rounds deliveries, rounds 1 to 5; one answer is waited for at most 120 seconds. Free mode: at most `--max-messages` deliveries (default the room's budget, else 8; at most 20); it also stops when a pass reads no new answer, after `--timeout` (default 300 seconds) or on Ctrl-C.
  - The members that cannot be asked (listeners and the local members) get the record once at the end, if they are still members then.
  - A chat that was busy when its turn arrived receives the message, but no answer is read for that turn. In free mode a speaker with no answer twice in a row gets no more deliveries.
  - OpenCode desktop sessions are never attached, so they never speak. The Antigravity IDE app was not tested.
  - An answer is cut to its first 1,200 characters and its control characters are replaced by spaces; a speaker is shown at most the last 12 answers of the others.
  - The speakers are chosen when the command starts, and membership is checked again before every delivery: a member that left the room during the discussion gets nothing more and is reported as `left`. (A chat that closed is not written to.)
  - The lead mark on a discussion's messages is also decided when the command starts: a lead replaced during its own discussion keeps the mark until that command ends.
  - Turn mode was run live on one Mac on 2026-11-20 with four speakers (a Claude Code session, a Codex chat, an Antigravity conversation and an OpenCode CLI session); free mode is covered by tests with fakes only.
- **Room lead and `room set`.** A lead is a verified Claude session or the operator's terminal (`local-operator`), never an attached chat and never `local-shell`. The opener leads until changed when it is one of those. An operator terminal can always change the lead; the opener or the current lead can when it can lead itself. Only the lead or an operator terminal may set the mode. The hard limits do not depend on the setting.
  - A room opened from an unverified shell (`local-shell`, which is any shell in the project folder, an agent's shell included) has no lead until an operator terminal runs `room lead`. Until then no member can assign tasks, set the mode or change it for one run; sending and discussing in the room's mode still work.
  - When the lead leaves and the opener is not a current member that can lead, the room is left without a lead.
  - Not run against the real apps. The tests use fakes.
- **`room assign`.** One delivery per named member, at most 20, all sent together, nobody retried; the wait is 300 seconds (`--timeout`, at most 1800).
  - Whether an assignee may do the task is decided by the assignee and its owner. Consessus only says in the message that the task is peer data.
  - A Ctrl-C that comes before the deliveries start sends nothing: every assignee is reported as `stopped`. Membership is checked again before each delivery: an assignee that left the room is reported as `left` and gets nothing.
  - A member is looked up by a whole id first and then by a unique start of one. A whole id that names a member who left, or the caller, is never read as the start of another member's id: the assignment is refused.
  - Run live on one Mac on 2026-11-20: four tasks, four answers read back.
- **The room lock.** A room runs one discussion or one assignment at a time; a second command is refused and sends nothing.
  - A command that is killed (or Ctrl-C in turn mode, which quits at once) leaves the lock until the end time it stored. After that the next command takes it.
  - The end time is written, and believed when read, for at most about 42 minutes (20 deliveries × 125 seconds, plus 10 seconds), so a killed command locks a room for at most that long. The time limit of a free discussion has the same ceiling.
  - `room send` is not locked.
- **Room files edited by hand.** Room state is an owner-only file. The stored lead and discussion setting are checked on every read. A lock, a member listed twice or a member id with unusual characters written by hand is not checked: a stored lock with a far end time keeps discussions out until it is removed, and a chat listed twice gets two deliveries.
- **Read limits.** Every read from another session is bounded: a reply is cut at 64 KB, a Claude transcript is read at most 8 MB at a time for an answer and 2 MB for the model and mode, Codex profiles at most 200 rows in one call, Antigravity the last 3 steps, an OpenCode answer the newest 200 messages. The README section "Read limits" has the full table.
- **`consessus watch`.** It checks the session list every 2 seconds and prints `appeared`, `status` and `gone` lines. A change of permission mode is not reported. An app that cannot be reached keeps its last known sessions.
- **The MODE column of `consessus sessions`.** Read-only: it reports how each app is set to treat tool approvals, from that app's local settings, and Consessus never changes a permission mode. Claude sessions show the mode written with their last prompt in the session's transcript, or `-` when it is not near the end of that file. The OpenCode value comes from the user's `opencode.json`, so it is the same for every OpenCode session. When a listed session asks or may ask, `consessus sessions` prints a line that says so; check it before you send. `send --to` into such a session prints a note with its result that the answer may wait for approval there; the message is still sent.
- **One machine, one user.** Everything runs over local Unix sockets and loopback HTTP. Nothing is sent to another host.
