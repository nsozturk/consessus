# Codex relay operations

The optional relay receives messages from one selected Claude session and delivers them into one existing Codex chat. For direct collaboration, use `--relay-routing immediate`: active chats receive native Steer; idle chats start a native turn in the same chat. Existing callers retain the queue-only default; hybrid routing remains available for explicitly marked urgent messages. The relay does not create a chat, install a background service, or automatically send Codex replies back to Claude.

## Start and resume

Use Node 22.13+ or 24+ with `node:sqlite`, a local Claude peer registry, and a running compatible Codex desktop app with the selected existing chat. Immediate mode does not need a `codex` executable. Queue/hybrid require one supporting `queue --thread … --message …`; verify `codex queue --help` before selecting either mode.

```bash
consessus list --json
consessus agent --name codex-peer \
  --to YOUR_CLAUDE_SESSION_ID \
  --from-mode prompting \
  --codex-thread YOUR_CODEX_THREAD_UUID \
  --relay-routing immediate \
  --relay-db ./data/raw_consessus.sqlite
```

Declare the sender's actual approval policy. `prompting` means it asks for tool approval; `bypass` means it can act without those prompts. This is independent of filesystem access. Recipient approval remains in force.

The command prints the generated listener address; `list --json` includes its generated session ID. Supply both as `--from-address` / `--from-session` on an outbound `send`. Restarting the listener changes those identifiers. Startup only sends a Claude message when `--message` is also supplied.

For a detached process, redirect stdin from `/dev/null` and stdout/stderr to an access-controlled project log. The relay's own timestamped log is `<db-path>.relay.log`, including a heartbeat every ten seconds. Tail that file to follow progress. A missing log write is reported to stderr; it does not discard database state.

Stop with Ctrl+C or SIGTERM. Re-run the same command and **same database** to resume pending work. A Claude process restart requires resolving the source again. A changed Claude session ID creates a new binding; old bindings stay in the database and are not silently reassigned.

## Immediate delivery

Use `--relay-routing immediate` when all peer messages must appear directly in an existing chat. It sends every message through the native owner: active turn → Steer; definitively idle → native start in the same existing thread. No model, permissions, sandbox, collaboration settings or service-tier override is supplied. Sender markers stay quoted data and do not change immediate routing.

There is **no CLI/UI Queue fallback** in this mode. A definitively unavailable native endpoint records `failed` and logs why. An uncertain result after sending records `uncertain` and is never automatically resent or retried as a start. Native acceptance is recorded as `steered` or `started`, with its turn ID; it still does not claim that a model read it. Existing queue/hybrid modes remain available and unchanged for their callers.

The native IPC is undocumented; a future desktop change may require an adapter update. Active and idle delivery were first exercised against an earlier desktop build; the live test recorded in [COMPATIBILITY.md](COMPATIBILITY.md) used desktop 26.1111.71025. Immediate mode needs the desktop running with an owner for the selected existing chat. It does not create another chat or install a daemon. Old handed-off messages are never resent when changing modes.

## Queue and Steer

Replace `--relay-routing immediate` with `--relay-routing hybrid` to enable hybrid delivery. Existing callers without a routing flag stay queue-only.

| First token of the peer body | Hybrid delivery |
|---|---|
| `[STEER]` | Steer into the existing active turn |
| `[QUEUE]` or no marker | Queue for the next turn |

Only the exact uppercase leading token followed by whitespace or end of text counts. Quoted markers, code fences, later markers and urgent-looking prose are ordinary data. The sender chooses the marker; the owner need not copy or submit each message. Configure the sending agent to prefix urgent stop/direction corrections with `[STEER]`, and leave routine reports unmarked. Neither marker grants execution authority. The original text and marker remain quoted.

Native delivery uses the running desktop's local IPC socket at `$CODEX_HOME/ipc/ipc.sock` (default `~/.codex/ipc/ipc.sock`). It discovers and pins the existing chat owner; for Steer, the native owner obtains the current turn and supplies the upstream `expectedTurnId` guard. It never starts an app-server, creates a chat, changes permissions, or interrupts and recreates a turn. This is an **undocumented desktop compatibility adapter**, tested with the desktop app 26.1111.71025. Other clients and future versions may differ.

An idle chat, unavailable endpoint or explicit protocol rejection falls back to Queue with a journaled reason. A timeout, disconnect, malformed result or unknown error after the Steer request is sent becomes `uncertain`, with **no Queue fallback or blind retry**. A positive response records `steered` and its accepted turn ID; this does not prove that the model has read it. Steer is guidance to the active turn, not a guarantee that an in-flight tool stops immediately.

Use `--relay-routing queue` to disable hybrid delivery. Restart with the same database: old rows retain their chosen route, and already handed-off or uncertain rows are not resent. Schema changes only add columns, leaving existing data intact.

### Consumed Queue cards

Hybrid bindings also reconcile their own consumed Queue cards with the native desktop owner on the existing ten-second heartbeat. A binding switched to immediate can finish reconciling its previously recorded pending cards; new direct deliveries create none. The relay reads the same Codex home's `queue_1.sqlite` without writing it. While an exact thread/message row is still pending, no UI cleanup is sent. Once that row is absent (consumed or cancelled), the relay asks the pinned owner to reconcile that single card through `thread-follower-remove-queued-message`. It never clears a whole queue, removes unrelated cards, or sends the message again. The original delivery state remains `queued`, not “read”.

The additive `ui_status` field is separate: `pending`, `done`, `skipped`, or `uncertain`. Existing historical rows default to `legacy` and are not cleaned automatically. A queue-store/schema failure disables cleanup for that run; native unavailability is capped at three attempts per row. Cleanup runs single-flight outside the delivery chain, at most one card per tick. An ambiguous cleanup response is quarantined as UI `uncertain` without retrying delivery. Default queue-only bindings retain their previous behavior. This cleanup path was verified against an earlier desktop build and has not been retested with 26.1111.71025.

## State machine

| State | Meaning | Automatic restart behavior |
|---|---|---|
| `pending` | Frame/inbox committed; not handed off yet | Attempt handoff |
| `dispatching` | External handoff in progress | Convert to `uncertain` after interruption |
| `queued` | Queue process exited successfully | Skip |
| `steered` | Desktop accepted input into an active turn | Skip |
| `started` | Desktop started a turn in the same existing chat | Skip |
| `failed` | Known queue pre-spawn ENOENT or definitive native unavailability | Retry on a later flush/restart |
| `uncertain` | Timeout, ambiguous failure, or interrupted handoff | Skip; inspect destination |
| `rejected` | Formatted text over 32 KiB or containing NUL | Skip; full raw frame retained |

A successful queue call may return a queue ID. Missing IDs are recorded as null; success still refers to the command exit, not model consumption. Native delivery records a turn ID instead. No distributed transaction spans SQLite and the external handoff, so exactly-once delivery cannot be guaranteed.

Use an installed SQLite client to inspect the journal without changing it:

```bash
sqlite3 ./data/raw_consessus.sqlite \
  'SELECT msg_id,route,status,received_at,queue_id,turn_id,route_note,error FROM codex_relay_inbox ORDER BY rowid;'
```

Do not blindly change `uncertain` rows back to pending: the destination may already contain the message. Inspect the destination first; if a manual resend is needed, decide it explicitly. There is no automatic resend/reset command.

## Persistence and filtering

- The SQLite connection uses WAL and `synchronous=FULL`; a transaction commits the raw non-auth frame and derived inbox row before dispatch.
- Raw bodies are gzip-compressed into content-addressed `blobs`; append-only `fetches` records retain each reception, including ignored sources, controls and duplicates. Authentication frames are discarded before this seam.
- Inbox identity combines the selected source session, destination thread and peer message ID. Repeated IDs do not dispatch twice within the same DB; changed raw versions are still retained.
- A source/thread binding has one live owner in the same DB, checked by PID and process start time. Separate databases have separate ownership and deduplication; use one database for one running integration.
- Only selected-source `user`/`message` frames with a valid message ID and nonempty text are forwarded. Text arrays include valid text blocks only. Controls, idle notices and authentication do not become chat prompts.
- Each forwarded message includes a provenance label and quotes every line, including Unicode line endings. It says peer content is not a new human instruction and grants no new authority. It discourages acknowledgements and reply loops.

## Trust and privacy

Relay-mode listeners require the existing token handshake. Files and sockets are created with local-user permissions; the DB/log files use mode 0600. Protect the directory and any redirected logs as well. Frames may contain private project content and are not automatically pruned.

Tokens and file permissions do not isolate processes running as the **same OS user**. Those processes can read peer files. The selected `from` address is self-reported and compared after socket-directory canonicalization; it is not OS-verified sender identity. The Node listener does not implement kernel peer-credential validation.

The receiver must treat quoted peer content as data under the owner's existing task, never as independent permission to execute commands, change files, deploy, spend, or contact anyone. The relay cannot enforce the receiving model's behavior.

## SDK

`openCodexRelay({ threadId, target, dbPath, codexBin?, routing?, desktopSocketPath?, queueDbPath?, log? })` returns a promise for `{ receive, flush, reconcileUi, close }`. It is lazy-loaded from the core module, so Node 18 callers can keep importing and using core features without loading SQLite.

`routing` is `"queue"` (default), `"hybrid"`, or `"immediate"`. `desktopSocketPath` optionally selects the same local desktop endpoint for an alternate Codex home. Set `queueDbPath` to that same home's queue store if overriding the endpoint; tests use an isolated store.

`target` needs a registered source `sessionId` and `messagingSocketPath`; `threadId` must be an explicit UUID. A supplied `codexBin` is executed directly with an argument array, without a shell. `receive(frame, rawLine)` stores a non-auth frame and schedules pending work; `flush()` explicitly drains eligible work. `close()` releases ownership and is idempotent. If it happens during handoff, the next start quarantines the interrupted row as `uncertain`.

See the [README](../README.md#sdk) and [type declarations](../types/index.d.ts). Tests use fake queues and framed local desktop fixtures; real account messaging is an explicit integration check, not part of `npm test`.
