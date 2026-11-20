# Local Claude peer protocol notes

These notes describe an **undocumented, version-sensitive** integration originally inspected against Claude Code 2.1.318 and a macOS Claude Desktop installation. They are historical observations, not an official API or a compatibility guarantee for every client/version.

## Discovery

Claude sessions may publish `<pid>.json` records under `~/.claude/sessions/`, including PID, session ID, cwd, status, and `messagingSocketPath`. The SDK filters for live PIDs and optionally probes sockets. `CLAUDE_CONFIG_DIR` selects another profile at module load.

A matching key file uses `<pid>.<sha256(path.resolve(socketPath))>.key`. The client reads its peer token without logging it, and tries the canonical real path too, accommodating `/tmp` / `/private/tmp` aliases. Key-file hashing locates a credential; the hash is not itself authentication.

## Wire format

Connections use newline-delimited JSON. Where a peer token exists, the first line is a token-bearing authentication frame. Never copy that frame or key file into logs, examples, or a repository.

A message follows this general shape (identifiers below are synthetic):

```json
{
  "msg_id": "example-message-1",
  "ts": "2026-11-10T12:00:00.000Z",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<cross-session-message from=\"uds:/tmp/cc-socks/54321.sock\" from-session=\"example-peer-session\" from-name=\"worker\" from-mode=\"prompting\">\nPlease discuss the current task.\n</cross-session-message>"
  },
  "priority": "next",
  "from": "uds:/tmp/cc-socks/54321.sock"
}
```

The outer `from` and XML reply attributes route receipts/replies to a live listener. `from-mode` declares the sender's actual approval policy, not sandbox access or the recipient's mode. Public v1 sends retain an omitted attribute for existing callers that do not supply it. New integrations should explicitly declare it.

Control frames can request `rename` or `notify_when_idle`. A `peer_message_status` control carries `orig_msg_id` and a status such as `held`, `delivered`, `denied`, `refused`, `dropped`, or `expired`. Native UI and peer-tool availability depend on the receiving client.

## Timing and evidence

The sender retains the original 150 ms macOS close delay after writing as an observed compatibility workaround. It is not a guarantee against data loss. Socket completion only means the frame was written; actual receipts and replies provide stronger, distinct evidence. See [delivery semantics](../README.md#delivery-and-permissions).

The original adapter registered an external peer and observed a native `SendMessage` reply from a Claude session. Current automated tests use isolated fake listeners and queue executables; they do not certify current Claude Desktop UI behavior.

## Trust boundary

The Node listener can require its token handshake (`requireAuth: true`); this is always enabled for the Codex relay. Generic SDK daemons keep the original opt-in default for compatibility. Authentication frames are never exposed to `onFrame` or persisted by the relay.

Claude's native receiver may perform platform-specific kernel peer checks. This Node daemon **does not** implement equivalent kernel credential verification. Any process running as the same OS user can access the same token files and spoof self-reported source fields. Do not present this protocol as isolation from malicious same-user processes.

Transcript streaming reads client-written JSONL records from the local project directory. It observes saved text/tool entries; it cannot recover unavailable internal reasoning.
