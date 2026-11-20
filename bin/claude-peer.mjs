#!/usr/bin/env node
// The old command name. It runs the same CLI.
console.error("claude-peer was renamed to Consessus. Use the `consessus` command; this alias will be removed in a later version.");
await import("./consessus.mjs");
