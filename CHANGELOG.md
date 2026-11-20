# Changelog

## 1.0.1 (2026-11-20)

### Changed

- **A send to a Claude session reports a receipt.** The receipt says what the session's own record shows:
  - `recorded`: Claude Code wrote the message down, as a new turn when the session was idle or attached to the running turn.
  - `unconfirmed`: not written down within 4 seconds. The session is busy and will record it when its current step ends, or the message is held for approval in the Claude app, or the session does not accept peer messages.
  - `unknown`: the target is a Consessus listener or a socket path, which keeps no record.

  With `send --to claude:<id>` the JSON result has `receipt` and, unless the receipt is `recorded`, a `note`; `status` is `delivered` only when the receipt is `recorded`, otherwise `sent`. Plain `send --to <pid|name|socket>` prints the receipt on its `Frame written` line and the note on standard error.
- **Sending to a Claude session from outside a Claude session needs `--from-mode prompting|bypass`.** Measured on 2026-11-20: Claude takes a bare message only from a process that runs inside a Claude session. From another app's shell (such as OpenCode's), a detached job or a sandbox where the process tree cannot be read, the Claude app held the message for approval with the reason "the sender did not state its permission mode", or dropped it, and the sender saw only "frame written".
  - `--from-mode` is the sender's own approval policy: `prompting` means it asks before acting, `bypass` means it acts without permission prompts.
  - Without it the command stops with an explanation and sends nothing.
  - With it, Consessus registers the sender as a peer for the length of the send, sends with that identity, reads the receipt and removes the registration.
  - If the declared mode differs from the target session's mode, the Claude app may still hold the message for the owner's approval. That is the app's rule; Consessus reports `unconfirmed` with the note.
  - Sends to a listener or a socket path are unchanged and need no mode. Inside a Claude session nothing changes.

### Fixed

- **`consessus sessions` inside a sandbox.** Claude sessions are listed even when the process list cannot be read (a sandbox that forbids `ps`). Only the difference between a listener and a model is lost there.
- **A `send --to` id that is not listed.** The error says which app lists could not be read and why ("The claude sessions could not be listed (…), so the session may still be open"). For an `opencode:` target or an id that starts with `ses_` it adds that OpenCode desktop sessions are not listed and how to reach one through a listener (`consessus agent --name <name> --inbox --opencode-session auto`).

### Known limits

- A Claude session's id changes when its conversation is compacted, and the old id stops resolving. There is no alias yet.
- An answer that was not read because the session was busy cannot be read later. There is no `read --after` command yet.

## 1.0.0 (2026-11-19)

First release as Consessus, the project formerly named claude-peer: a free, open-source CLI for macOS that lets Claude Code, Codex, OpenCode and Antigravity sessions on the same machine message each other and share project rooms. It lists the open sessions of the four apps with permission mode and model, sends to a listed session and reads its answer in the same command, and runs project rooms with bounded discussions, a room lead that assigns tasks and member introductions.
