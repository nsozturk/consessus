import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { listSessions, formatSessions, opencodeSource, antigravitySource, codexOpenThreads, claudeSource } from "../src/sessions.mjs";

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const listen = handler => new Promise(resolve => {
  const calls = [];
  const server = http.createServer((req, res) => { calls.push({ url: req.url, auth: req.headers.authorization, token: req.headers["x-codeium-csrf-token"] }); handler(req, res); });
  server.listen(0, "127.0.0.1", () => resolve({ calls, port: server.address().port, close: () => new Promise(done => server.close(done)) }));
});

test("merges every source, keeps going when one fails, and filters by project folder", async () => {
  const project = tmp("consessus-sessions-");
  fs.mkdirSync(path.join(project, "sub"));
  const sources = [
    ["claude", async () => [{ id: "c1", path: project, status: "idle" }, { id: "c2", path: "/elsewhere", status: "busy" }]],
    ["codex", async () => { throw new Error("socket missing"); }],
    ["antigravity", async () => [{ id: "a1", path: path.join(project, "sub"), status: "running" }, { id: "a2", path: null, status: "idle" }]],
    ["opencode", async () => []],
  ];
  const modeOf = () => undefined;
  const all = await listSessions({ sources, modeOf });
  assert.deepEqual(all.sessions.map(row => `${row.app}:${row.id}`), ["claude:c1", "claude:c2", "antigravity:a1", "antigravity:a2"]);
  assert.deepEqual(all.unavailable, [{ app: "codex", reason: "socket missing" }]);
  const scoped = await listSessions({ sources, project, modeOf });
  assert.deepEqual(scoped.sessions.map(row => row.id), ["c1", "a1"]);
  const text = formatSessions(all);
  assert.match(text, /claude\s+idle\s+-\s+-\s+c1\s/);
  assert.match(text, /codex: not available \(socket missing\)/);
  assert.match(formatSessions({ sessions: [], unavailable: [] }), /No sessions found/);
});

test("OpenCode: reads the service's own owner-only registration file and lists sessions with their folder and state", async () => {
  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) { res.writeHead(401).end("{}"); return; }
    if (req.url.startsWith("/api/session/active")) { res.end(JSON.stringify({ data: { ses_b: {} } })); return; }
    const recent = Date.now() - 60_000, old = Date.now() - 13 * 3600_000;
    res.end(JSON.stringify({ data: [
      { id: "ses_a", title: "First", location: { directory: "/p/a" }, time: { updated: recent } },
      { id: "ses_b", title: "Second", location: { directory: "/p/b" }, time: { updated: old } },
      { id: "ses_old", title: "Finished long ago", location: { directory: "/p/c" }, time: { updated: old } },
    ] }));
  });
  try {
    const dir = tmp("consessus-oc-");
    const file = path.join(dir, "service.json");
    fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, password: "pw", pid: 4242 }), { mode: 0o600 });
    const rows = await opencodeSource({ registration: file, isAlive: () => true });
    assert.deepEqual(rows, [{ id: "ses_a", path: "/p/a", status: "idle", title: "First" }, { id: "ses_b", path: "/p/b", status: "busy", title: "Second" }]);
    fs.chmodSync(file, 0o644);
    await assert.rejects(opencodeSource({ registration: file, isAlive: () => true }), /registration/);
    fs.chmodSync(file, 0o600);
    await assert.rejects(opencodeSource({ registration: file, isAlive: () => false }), /not running/);
    let asked = 0;
    const spy = async () => { asked++; throw new Error("must not be called"); };
    for (const url of ["http://example.com:1", `https://127.0.0.1:${server.port}`, "http://127.0.0.2:1", "http://localhost.example.com:1", "not a url"]) {
      fs.writeFileSync(file, JSON.stringify({ url, password: "pw", pid: 4242 }), { mode: 0o600 });
      await assert.rejects(opencodeSource({ registration: file, isAlive: () => true, request: spy }), /loopback/);
    }
    assert.equal(asked, 0);
  } finally { await server.close(); }
});

test("Antigravity: lists the server's conversations with workspace folder and run state", async () => {
  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-codeium-csrf-token"] !== "tok") { res.writeHead(403).end("{}"); return; }
    res.end(JSON.stringify({ trajectorySummaries: {
      "id-1": { status: "CASCADE_RUN_STATUS_RUNNING", summary: "One", trajectoryMetadata: { workspaces: [{ workspaceFolderAbsoluteUri: "file:///p/one" }] } },
      "id-2": { status: "CASCADE_RUN_STATUS_IDLE", summary: "Two", trajectoryMetadata: {} },
    } }));
  });
  try {
    const home = tmp("consessus-agy-");
    fs.mkdirSync(path.join(home, "daemon"));
    fs.writeFileSync(path.join(home, "daemon", "hub_1.json"), JSON.stringify({ pid: 4242, httpPort: server.port, csrfToken: "tok" }), { mode: 0o600 });
    assert.deepEqual(await antigravitySource({ home, isAlive: () => true }), [
      { id: "id-1", path: "/p/one", status: "running", title: "One" }, { id: "id-2", path: null, status: "idle", title: "Two" },
    ]);
  } finally { await server.close(); }
});

test("Codex: collects the chats the desktop announces as open and never claims a request", async () => {
  const dir = tmp("consessus-codex-");
  const socketPath = path.join(dir, "ipc.sock");
  const frame = message => { const body = Buffer.from(JSON.stringify(message)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };
  const received = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, 4 + size)); buffer = buffer.subarray(4 + size);
        received.push(message);
        if (message.method === "initialize") {
          socket.write(frame({ type: "response", requestId: message.requestId, resultType: "success", result: { clientId: "me" } }));
          socket.write(frame({ type: "broadcast", method: "thread-stream-following-changed", params: { conversationId: "t-open", hostId: "local", following: true } }));
          socket.write(frame({ type: "broadcast", method: "thread-stream-following-changed", params: { conversationId: "t-closed", hostId: "local", following: false } }));
          socket.write(frame({ type: "client-discovery-request", requestId: "d1", request: {} }));
          socket.write(frame({ type: "broadcast", method: "thread-queued-followups-changed", params: { conversationId: "t-other", messages: [{ text: "private" }] } }));
        }
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    assert.deepEqual(await codexOpenThreads({ socketPath, windowMs: 150 }), ["t-open"]);
    assert.deepEqual(received.map(message => message.method ?? message.type), ["initialize", "client-discovery-response"]);
    assert.deepEqual(received[1].response, { canHandle: false });
    await assert.rejects(codexOpenThreads({ socketPath: path.join(dir, "missing.sock"), windowMs: 50 }), /Codex desktop/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Claude: labels Consessus listener processes separately from real Claude sessions", async () => {
  const list = async () => [
    { pid: 11, sessionId: "real", name: "Work", status: "busy", cwd: "/p", messagingSocketPath: "/tmp/a.sock" },
    { pid: 22, sessionId: "bridge", name: "oc-room", status: "idle", cwd: "/p" },
    { pid: 33, sessionId: "prompted", name: "Test", status: "idle", cwd: "/p" },
  ];
  const commands = async () => new Map([[11, "claude --resume"], [22, "node /opt/consessus/bin/consessus.mjs agent --name oc-room --inbox"],
    [33, "claude --dangerously-skip-permissions run: node /opt/consessus/bin/consessus.mjs agent --name x"]]);
  assert.deepEqual(await claudeSource({ list, commands }), [
    { id: "real", path: "/p", status: "busy", title: "Work", address: "uds:/tmp/a.sock" },
    { id: "bridge", path: "/p", status: "listener", title: "oc-room", address: undefined },
    { id: "prompted", path: "/p", status: "idle", title: "Test", address: undefined },
  ]);
});

test("project filter keeps a child folder whose name starts with two dots and follows symlinks", async () => {
  const parent = tmp("consessus-scope-");
  const project = path.join(parent, "proj");
  fs.mkdirSync(path.join(project, "..foo"), { recursive: true });
  fs.mkdirSync(path.join(parent, "proj-sibling"));
  fs.symlinkSync(project, path.join(parent, "link"));
  const sources = [["claude", async () => [
    { id: "dots-child", path: path.join(project, "..foo") }, { id: "sibling", path: path.join(parent, "proj-sibling") },
    { id: "parent", path: parent }, { id: "via-link", path: path.join(parent, "link") }, { id: "root", path: project },
  ]]];
  assert.deepEqual((await listSessions({ sources, project })).sessions.map(row => row.id), ["dots-child", "via-link", "root"]);
  assert.deepEqual((await listSessions({ sources, project: path.join(parent, "link") })).sessions.map(row => row.id), ["dots-child", "via-link", "root"]);
});

test("a source that returns something other than a list is reported unavailable, not fatal", async () => {
  const result = await listSessions({ sources: [["claude", async () => ({ nope: true })], ["codex", async () => [null, { id: "x", path: null }]],
    ["opencode", async () => { throw "bare"; }]] });
  assert.deepEqual(result.sessions.map(row => row.id), ["x"]);
  assert.deepEqual(result.unavailable, [{ app: "claude", reason: "returned no session list" }, { app: "opencode", reason: "unavailable" }]);
});

const codexFrame = message => { const body = Buffer.from(JSON.stringify(message)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };
const following = (conversationId, value, method = "thread-stream-following-changed") => codexFrame({ type: "broadcast", method, params: { conversationId, following: value } });
async function fakeCodex(onInitialize) {
  const dir = tmp("consessus-codex2-");
  const socketPath = path.join(dir, "ipc.sock");
  const seen = { connections: 0 };
  const server = net.createServer(socket => {
    seen.connections++;
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, 4 + size)); buffer = buffer.subarray(4 + size);
        if (message.method === "initialize") onInitialize(socket);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  return { dir, socketPath, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test("Codex: a frame over the size cap is skipped unread and later frames still count", async () => {
  const codex = await fakeCodex(socket => {
    const head = Buffer.alloc(4); head.writeUInt32LE(2 * 1024 * 1024 + 7);
    socket.write(following("t-before", true));
    socket.write(head); socket.write(Buffer.alloc(2 * 1024 * 1024 + 7, 0x7b));
    socket.write(following("t-after", true));
  });
  try { assert.deepEqual(await codexOpenThreads({ socketPath: codex.socketPath, windowMs: 400 }), ["t-before", "t-after"]); }
  finally { await codex.close(); }
});

test("Codex: zero-length or unparsable frames reject; silence and early hang-up still settle", async () => {
  for (const [bad, pattern] of [[Buffer.alloc(4), /Codex desktop/], [Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{{{")]), /Codex desktop/]]) {
    const codex = await fakeCodex(socket => socket.write(bad));
    try { await assert.rejects(codexOpenThreads({ socketPath: codex.socketPath, windowMs: 2000 }), pattern); }
    finally { await codex.close(); }
  }
  for (const behave of [() => {}, socket => socket.end(), socket => socket.write(Buffer.from([9, 0]))]) {
    const codex = await fakeCodex(behave);
    try { assert.deepEqual(await codexOpenThreads({ socketPath: codex.socketPath, windowMs: 100 }), []); }
    finally { await codex.close(); }
  }
});

test("Codex: following must be exactly true, and only the following broadcast is read", async () => {
  const codex = await fakeCodex(socket => {
    socket.write(following("t-a", true)); socket.write(following("t-b", true)); socket.write(following("t-a", false));
    socket.write(following("t-c", "true")); socket.write(following("t-d", 1));
    socket.write(following("t-x", true, "thread-queued-followups-changed"));
    socket.write(codexFrame({ type: "notice", method: "thread-stream-following-changed", params: { conversationId: "t-y", following: true } }));
    socket.write(codexFrame({ type: "broadcast", method: "thread-stream-following-changed", params: { conversationId: 7, following: true } }));
    socket.write(codexFrame({ type: "broadcast", method: "thread-stream-following-changed" }));
  });
  try { assert.deepEqual(await codexOpenThreads({ socketPath: codex.socketPath, windowMs: 200 }), ["t-b"]); }
  finally { await codex.close(); }
});

test("Codex: refuses a socket that is a symlink, a plain file, or owned by another user, without connecting", async () => {
  const codex = await fakeCodex(socket => socket.write(following("t-open", true)));
  const link = path.join(codex.dir, "link.sock"), plain = path.join(codex.dir, "plain.sock");
  fs.symlinkSync(codex.socketPath, link); fs.writeFileSync(plain, "");
  const getuid = process.getuid;
  try {
    for (const socketPath of [link, plain]) await assert.rejects(codexOpenThreads({ socketPath, windowMs: 50 }), /Codex desktop/);
    process.getuid = () => getuid() + 1;
    await assert.rejects(codexOpenThreads({ socketPath: codex.socketPath, windowMs: 50 }), /Codex desktop/);
    process.getuid = getuid;
    assert.equal(codex.seen.connections, 0);
    assert.deepEqual(await codexOpenThreads({ socketPath: codex.socketPath, windowMs: 100 }), ["t-open"]);
  } finally { process.getuid = getuid; await codex.close(); }
});

async function fakeOpencode({ sessions, active = { data: {} }, activeStatus = 200, sessionsStatus = 200 }) {
  const server = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) { res.writeHead(401).end("{}"); return; }
    if (req.url.startsWith("/api/session/active")) { res.writeHead(activeStatus).end(JSON.stringify(active)); return; }
    res.writeHead(sessionsStatus).end(JSON.stringify({ data: sessions }));
  });
  const dir = tmp("consessus-oc2-");
  const file = path.join(dir, "service.json");
  const write = (fields = {}, mode = 0o600) => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, password: "pw", pid: 4242, ...fields }), { mode }); fs.chmodSync(file, mode); };
  write();
  return { server, dir, file, write, read: options => opencodeSource({ registration: file, isAlive: () => true, ...options }) };
}

test("OpenCode: refuses a registration that is group- or world-readable, a symlink, or owned by someone else", async () => {
  const oc = await fakeOpencode({ sessions: [] });
  const getuid = process.getuid;
  try {
    for (const mode of [0o640, 0o604, 0o620]) { oc.write({}, mode); await assert.rejects(oc.read(), /registration/); }
    oc.write();
    const link = path.join(oc.dir, "link.json");
    fs.symlinkSync(oc.file, link);
    await assert.rejects(opencodeSource({ registration: link, isAlive: () => true }), /registration/);
    await assert.rejects(opencodeSource({ registration: oc.dir, isAlive: () => true }), /registration/);
    process.getuid = () => getuid() + 1;
    await assert.rejects(oc.read(), /registration/);
    process.getuid = getuid;
    assert.equal(oc.server.calls.length, 0);
    assert.deepEqual(await oc.read(), []);
  } finally { process.getuid = getuid; await oc.server.close(); }
});

test("OpenCode: HTTP errors reject, a failing or empty active list leaves sessions idle, and odd shapes are tolerated", async () => {
  const recent = Date.now() - 60_000;
  const rows = [{ id: "constructor", time: { updated: recent } }, { id: "s1", title: "T", location: { directory: "/p" }, time: { updated: recent } }];
  let oc = await fakeOpencode({ sessions: rows, activeStatus: 500 });
  try {
    assert.deepEqual(await oc.read(), [{ id: "constructor", path: null, status: "idle", title: "" }, { id: "s1", path: "/p", status: "idle", title: "T" }]);
    oc.write({ password: "wrong" });
    await assert.rejects(oc.read(), /HTTP 401/);
  } finally { await oc.server.close(); }
  for (const active of [{ data: null }, {}, { data: { s1: {} } }]) {
    oc = await fakeOpencode({ sessions: rows, active });
    try { assert.deepEqual((await oc.read()).map(row => row.status), ["idle", active.data?.s1 ? "busy" : "idle"]); }
    finally { await oc.server.close(); }
  }
  oc = await fakeOpencode({ sessions: { not: "a list" } });
  try { assert.deepEqual(await oc.read(), []); } finally { await oc.server.close(); }
  oc = await fakeOpencode({ sessions: [], sessionsStatus: 503 });
  try { await assert.rejects(oc.read(), /HTTP 503/); } finally { await oc.server.close(); }
});

test("OpenCode: the recent window is measured from now and busy sessions always count", async () => {
  const hour = 3600_000;
  const oc = await fakeOpencode({ sessions: [
    { id: "inside", time: { updated: Date.now() - hour + 5000 } }, { id: "outside", time: { updated: Date.now() - hour - 5000 } },
    { id: "never" }, { id: "future", time: { updated: Date.now() + hour } }, { id: "old-busy", time: { updated: 1 } },
  ], active: { data: { "old-busy": {} } } });
  try { assert.deepEqual((await oc.read({ recentMs: hour })).map(row => row.id), ["inside", "future", "old-busy"]); }
  finally { await oc.server.close(); }
});

test("Claude: listener labelling needs the node binary, a Consessus script and the agent or room subcommand", async () => {
  const commands = new Map([[1, "/usr/local/bin/node /x/consessus.mjs room --name r"], [2, "node /x/claude-peer.mjs agent"], [3, "node /x/cc-peer-bridge.mjs agent"],
    [4, "node /x/consessus.mjs agents"], [5, "node /x/consessus.mjs send agent"], [6, "nodejs-wrapper /x/consessus.mjs agent"],
    [7, "node /x/consessusXmjs agent"], [8, "node /x/notconsessus.mjs agent"], [9, "xnode /x/consessus.mjs agent"]]);
  const list = async () => [...commands.keys()].map(pid => ({ pid, sessionId: `s${pid}`, cwd: "/p" }));
  const rows = await claudeSource({ list, commands: async () => commands });
  assert.deepEqual(rows.map(row => row.status), ["listener", "listener", "listener", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(await claudeSource({ list: async () => [], commands: async () => { throw new Error("ps must not run"); } }), []);
});

test("Antigravity: only a running cascade is running and a non-file workspace has no folder", async () => {
  const request = async () => ({ ok: true, json: async () => ({ trajectorySummaries: {
    a: { status: "CASCADE_RUN_STATUS_RUNNING_X", trajectoryMetadata: { workspaces: [{ workspaceFolderAbsoluteUri: "https://example.com/p" }] } },
    b: { status: "CASCADE_RUN_STATUS_RUNNING", summary: "B", trajectoryMetadata: { workspaces: [{ workspaceFolderAbsoluteUri: "file:///p/b/" }, { workspaceFolderAbsoluteUri: "file:///p/c" }] } },
  } }) });
  const home = tmp("consessus-agy2-");
  fs.mkdirSync(path.join(home, "daemon"));
  fs.writeFileSync(path.join(home, "daemon", "hub.json"), JSON.stringify({ pid: 4242, httpPort: 9, csrfToken: "tok" }), { mode: 0o600 });
  assert.deepEqual(await antigravitySource({ home, isAlive: () => true, request }), [
    { id: "a", path: null, status: "idle", title: "" }, { id: "b", path: "/p/b", status: "running", title: "B" },
  ]);
});

test("formatSessions flattens control characters and line breaks in every column", () => {
  const text = formatSessions({ sessions: [{ app: "claude", status: "idle", id: "i\nd", path: "/p\r\x1b[2J", title: "line one\nline two\u2028three\u0085\u202eevil\u2069" }],
    unavailable: [{ app: "codex", reason: "bad\nreason" }] });
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  assert.match(lines[1], /line one line two three/);
  assert.match(lines[2], /codex: not available \(bad reason\)/);
  assert.match(formatSessions({ sessions: [{ app: "a", status: "s", id: "i", path: null, title: "t".repeat(80) }], unavailable: [] }).split("\n")[1], /\s-\s+t{60}$/);
});

test("Codex: a stale socket file left by a crashed app rejects instead of crashing the process", async () => {
  const dir = tmp("consessus-codex3-");
  const live = path.join(dir, "live.sock"), stale = path.join(dir, "stale.sock");
  const server = net.createServer();
  await new Promise(resolve => server.listen(live, resolve));
  fs.linkSync(live, stale);
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(codexOpenThreads({ socketPath: stale, windowMs: 50 }), /Codex desktop/);
});

test("with a project filter, a folder that is not an absolute path string is outside, never fatal", async () => {
  const project = tmp("consessus-scope2-");
  const sources = [["claude", async () => [{ id: "num", path: 123 }, { id: "empty", path: "" }, { id: "rel", path: "." }, { id: "obj", path: {} }, { id: "ok", path: project }]]];
  const cwd = process.cwd();
  try {
    process.chdir(project);
    assert.deepEqual((await listSessions({ sources, project })).sessions.map(row => row.id), ["ok"]);
  } finally { process.chdir(cwd); }
});

test("Claude: listener labelling matches whole path segments and an npm-linked bin without .mjs", async () => {
  const commands = new Map([[1, "xnode /x/consessus.mjs agent"], [2, "node /x/notconsessus.mjs agent"], [3, "node /opt/bin/consessus agent --inbox"],
    [4, "/usr/bin/node consessus.mjs room"], [5, "node /opt/bin/claude-peer agent"], [6, "node /opt/bin/consessus-old agent"]]);
  const list = async () => [...commands.keys()].map(pid => ({ pid, sessionId: `s${pid}`, cwd: "/p" }));
  assert.deepEqual((await claudeSource({ list, commands: async () => commands })).map(row => row.status),
    ["unknown", "unknown", "listener", "listener", "listener", "unknown"]);
});

test("each session carries its app's permission mode, and the table says where the owner changes a mode that asks", async () => {
  const sources = [
    ["codex", async () => [{ id: "t1", path: "/p", status: "open" }]],
    ["antigravity", async () => [{ id: "a1", path: "/p", status: "idle" }]],
    ["claude", async () => [{ id: "c1", path: "/p", status: "idle" }]],
  ];
  const modeOf = (app, id) => ({ codex: { mode: "full-access", asks: "never" }, antigravity: { mode: "request-review", asks: "always" } })[app]
    ?? { mode: "unknown", asks: "unknown" };
  const found = await listSessions({ sources, modeOf });
  assert.deepEqual(found.sessions.map(row => [row.app, row.id, row.mode, row.asks]), [
    ["codex", "t1", "full-access", "never"], ["antigravity", "a1", "request-review", "always"], ["claude", "c1", "unknown", "unknown"],
  ]);
  const text = formatSessions(found);
  assert.match(text, /^APP\s+STATUS\s+MODE\s+MODEL\s+ID\s+PATH\s+TITLE$/m);
  assert.match(text, /antigravity\s+idle\s+request-review \(asks\)\s+-\s+a1/);
  assert.match(text, /codex\s+open\s+full-access\s+-\s+t1/);
  assert.match(text, /claude\s+idle\s+-\s+-\s+c1/);
  assert.match(text, /antigravity: a message may wait for approval there\. In Antigravity, you change it/);
  assert.doesNotMatch(text, /codex: a message may wait/);
  const broken = await listSessions({ sources, modeOf: () => { throw new Error("unreadable"); } });
  assert.deepEqual(broken.sessions.map(row => row.asks), ["unknown", "unknown", "unknown"]);
});

test("the table has a MODEL column: the id, the effort in brackets when known, and - when unknown", () => {
  const profile = model => ({ profile: { model } });
  const text = formatSessions({ sessions: [
    { app: "codex", status: "open", id: "t1", path: "/p", title: "one", ...profile({ id: "gpt-6.2-sol", provider: "openai", effort: "xhigh", source: "app-record" }) },
    { app: "opencode", status: "idle", id: "s1", path: "/p", title: "two", ...profile({ id: "glm-5.3", source: "app-record" }) },
    { app: "antigravity", status: "idle", id: "a1", path: "/p", title: "three", ...profile({ id: "unknown", source: "unknown" }) },
    { app: "claude", status: "idle", id: "c1", path: "/p", title: "four" },
    { app: "claude", status: "idle", id: "c2", path: "/p", title: "five", ...profile({ id: "evil\nline\u001b[2J", effort: "x\ry" }) },
  ], unavailable: [] });
  const lines = text.split("\n");
  assert.match(lines[0], /^APP\s+STATUS\s+MODE\s+MODEL\s+ID\s+PATH\s+TITLE$/);
  assert.match(lines[1], /^codex\s+open\s+-\s+gpt-6\.2-sol \[xhigh\]\s+t1\s+\/p\s+one$/);
  assert.match(lines[2], /^opencode\s+idle\s+-\s+glm-5\.3\s+s1\s+\/p\s+two$/);
  assert.match(lines[3], /^antigravity\s+idle\s+-\s+-\s+a1\s+\/p\s+three$/);
  assert.match(lines[4], /^claude\s+idle\s+-\s+-\s+c1\s+\/p\s+four$/);
  // Whatever a caller hands the table, a model cannot break or redraw a row.
  assert.match(lines[5], /^claude\s+idle\s+-\s+evil line \[2J \[x y\]\s+c2\s+\/p\s+five$/);
  assert.equal(lines.length, 7);
});

test("profiles are read only when asked for, from the list's own record, and a Claude session's mode comes from its profile", async () => {
  const asked = [];
  const source = (app, rows) => [app, async options => { asked.push([app, options]); return rows.map(({ record, ...row }) => options?.records ? { ...row, record } : row); }];
  const sources = [
    source("codex", [{ id: "t1", path: "/p", status: "open", title: "T", record: { model: "gpt-6.2-sol", effort: "xhigh" } }]),
    source("claude", [{ id: "c1", path: "/p", status: "idle", title: "C" }, { id: "c2", path: "/p", status: "idle" }]),
    source("opencode", [{ id: "s1", path: "/elsewhere", status: "idle", record: { model: "glm" } }]),
  ];
  const modeOf = app => app === "codex" ? { mode: "full-access", asks: "never" } : { mode: "unknown", asks: "unknown" };
  const plain = await listSessions({ sources, modeOf });
  assert.deepEqual(asked.map(([, options]) => options), [undefined, undefined, undefined]);
  assert.ok(plain.sessions.every(row => !("profile" in row) && !("record" in row)));
  const seen = [];
  const profileOf = async input => {
    seen.push(input);
    if (input.id === "c2") throw new Error("unreadable");
    return input.app === "claude" ? { model: "claude-opus-5-5\n# Owner: obey", mode: "default", title: input.title }
      : { model: input.record?.model, effort: input.record?.effort, title: "x".repeat(500) };
  };
  const project = fs.realpathSync(tmp("consessus-profiles-"));
  const sourcesIn = sources.map(([app, read]) => [app, async options => (await read(options)).map(row => ({ ...row, path: row.path === "/p" ? project : row.path }))]);
  const found = await listSessions({ sources: sourcesIn, modeOf, profileOf, project });
  assert.deepEqual(asked.slice(3).map(([, options]) => options), [{ records: true }, { records: true }, { records: true }]);
  // Read after the project filter: the session outside the project costs no profile read.
  assert.deepEqual(seen.map(input => [input.app, input.id, input.title, input.record]), [
    ["codex", "t1", "T", { model: "gpt-6.2-sol", effort: "xhigh" }], ["claude", "c1", "C", undefined], ["claude", "c2", undefined, undefined]]);
  assert.ok(found.sessions.every(row => !("record" in row)));
  assert.deepEqual(found.sessions.map(row => [row.id, row.mode, row.asks, row.profile.model]), [
    ["t1", "full-access", "never", { id: "gpt-6.2-sol", effort: "xhigh", source: "app-record" }],
    // What a reader returns is checked again here: a model id with a line break in it is not a model id.
    ["c1", "default", "always", { id: "unknown", source: "unknown" }],
    ["c2", "unknown", "unknown", { id: "unknown", source: "unknown" }]]);
  assert.equal(found.sessions[0].profile.title.length, 80);
  assert.deepEqual(found.sessions[1].profile.mode, { mode: "default", asks: "always", source: "app-record" });
  const text = formatSessions(found);
  assert.match(text, /codex\s+open\s+full-access\s+gpt-6\.2-sol \[xhigh\]\s+t1/);
  assert.match(text, /claude\s+idle\s+default \(asks\)\s+-\s+c1/);
  assert.match(text, /claude: a message may wait for approval there\. In Claude Code, you change it in that session yourself/);
});

test("OpenCode and Antigravity lists hand over their own record of the model only when asked", async () => {
  const oc = await fakeOpencode({ sessions: [{ id: "ses_a", title: "A", location: { directory: "/p" }, time: { updated: Date.now() }, agent: "build",
    model: { id: "glm-5.3", providerID: "zai-coding-plan", variant: "high" } }, { id: "ses_b", time: { updated: Date.now() } }] });
  try {
    assert.deepEqual(await oc.read(), [{ id: "ses_a", path: "/p", status: "idle", title: "A" }, { id: "ses_b", path: null, status: "idle", title: "" }]);
    assert.deepEqual((await oc.read({ records: true })).map(row => row.record), [
      { model: "glm-5.3", provider: "zai-coding-plan", effort: "high" }, { model: undefined, provider: undefined, effort: undefined }]);
  } finally { await oc.server.close(); }
});
