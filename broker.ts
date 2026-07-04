#!/usr/bin/env bun
/**
 * claude-peers broker daemon (v2)
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and queues messages between them.
 *
 * v2 delivery model:
 *   - Messages stay `queued` until a hook in the *receiving* session calls
 *     /consume — which happens only when the message is actually injected
 *     into that session's context. No more fire-and-forget.
 *   - /poll-messages (v1) is deprecated and always returns []. This keeps
 *     still-running v1 MCP servers from destroying queued mail.
 *   - Peers get stable friendly names (from their repo/directory name).
 *   - If a message sits queued for >90s, the broker raises a macOS
 *     notification so the human knows a session is idle with mail waiting.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { loadConfig, hostLabel, machineId } from "./shared/config.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  ConsumeRequest,
  ConsumeResponse,
  FindPeerRequest,
  MessageStatusRequest,
  MessageStatusResponse,
  Peer,
  DeliveredMessage,
} from "./shared/types.ts";

export const BROKER_VERSION = "0.3.1";

const CONFIG = loadConfig();
const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BIND = process.env.CLAUDE_PEERS_BIND ?? CONFIG.bind ?? "127.0.0.1";
const IS_LOOPBACK_BROKER = BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1";
const TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? CONFIG.token ?? null;
const MY_HOST = hostLabel(CONFIG);
const MY_MACHINE = machineId();
// Queued mail older than this expires (dead-letter) instead of sitting forever
const MESSAGE_TTL_MS = 48 * 3600_000;
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const STALE_NOTIFY_MS = 90_000;
// Remote peers can't be PID-checked; they're alive while heartbeating (15s cadence)
const REMOTE_STALE_MS = 75_000;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// v1 → v2 schema migration (additive, safe to re-run)
function ensureColumn(table: string, col: string, ddl: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("peers", "name", "name TEXT NOT NULL DEFAULT ''");
ensureColumn("peers", "claude_pid", "claude_pid INTEGER");
ensureColumn("peers", "host", "host TEXT NOT NULL DEFAULT ''");
ensureColumn("peers", "machine_id", "machine_id TEXT NOT NULL DEFAULT ''");

// Peers registered before hosts existed are local to this broker
db.run("UPDATE peers SET host = ? WHERE host = ''", [MY_HOST]);

// Self-heal legacy registrations. On a loopback-only broker EVERY peer is
// this machine by definition, so rows from pre-machine-id clients (or from
// before a config file renamed the host label) can be safely claimed.
// Without this, a host-label change strands their queued mail — real
// incident: sessions registered under the raw hostname, a new config said
// "desktop", and delivery hooks stopped matching their mailboxes.
function adoptLegacyLocalPeers() {
  if (!IS_LOOPBACK_BROKER) return;
  db.run("UPDATE peers SET machine_id = ?, host = ? WHERE machine_id = ''", [MY_MACHINE, MY_HOST]);
}
adoptLegacyLocalPeers();
ensureColumn("messages", "status", "status TEXT NOT NULL DEFAULT 'queued'");
ensureColumn("messages", "delivered_at", "delivered_at TEXT");
ensureColumn("messages", "notified", "notified INTEGER NOT NULL DEFAULT 0");

// Backfill status from the v1 `delivered` flag
db.run(`UPDATE messages SET status = 'delivered' WHERE delivered = 1 AND status = 'queued'`);

// --- Friendly names ---

function baseName(peer: { cwd: string; git_root: string | null }): string {
  const source = peer.git_root ?? peer.cwd;
  const base = source.split("/").filter(Boolean).pop() ?? "peer";
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "peer";
}

function uniqueName(desired: string, excludeId?: string): string {
  const taken = new Set(
    (db.query("SELECT name FROM peers WHERE id != ?").all(excludeId ?? "") as { name: string }[])
      .map((r) => r.name)
      .filter(Boolean)
  );
  if (!taken.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Backfill names for peers registered under v1
{
  const unnamed = db.query("SELECT id, cwd, git_root FROM peers WHERE name = ''").all() as {
    id: string;
    cwd: string;
    git_root: string | null;
  }[];
  for (const p of unnamed) {
    db.run("UPDATE peers SET name = ? WHERE id = ?", [uniqueName(baseName(p), p.id), p.id]);
  }
}

// --- Stale peer cleanup ---

// Signal 0 checks existence without killing. Only ESRCH means the process
// is gone — EPERM (e.g. under a sandbox) means it exists but we can't
// signal it, and treating that as "dead" would wipe live peers.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function peerAlive(peer: { pid: number; host: string; machine_id: string; last_seen: string }): boolean {
  // Same machine as the broker (by stable id, or legacy label match) → PID check
  if (peer.machine_id === MY_MACHINE || (peer.machine_id === "" && peer.host === MY_HOST)) {
    return processAlive(peer.pid);
  }
  // Remote peer: judged by heartbeat freshness
  return Date.now() - new Date(peer.last_seen).getTime() < REMOTE_STALE_MS;
}

function cleanStalePeers() {
  adoptLegacyLocalPeers(); // late registrations from pre-0.3.1 clients
  const peers = db.query("SELECT id, pid, host, machine_id, last_seen FROM peers").all() as {
    id: string;
    pid: number;
    host: string;
    machine_id: string;
    last_seen: string;
  }[];
  for (const peer of peers) {
    if (!peerAlive(peer)) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND status = 'queued'", [peer.id]);
    }
  }
  // Dead-letter: expire mail that has sat queued past the TTL, so senders
  // see an honest terminal status instead of an eternal "queued".
  const cutoff = new Date(Date.now() - MESSAGE_TTL_MS).toISOString();
  db.run("UPDATE messages SET status = 'expired' WHERE status = 'queued' AND sent_at < ?", [cutoff]);
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// --- Stale-message escalation (human notification) ---

function notifyStaleMessages() {
  const cutoff = new Date(Date.now() - STALE_NOTIFY_MS).toISOString();
  const stale = db
    .query(
      `SELECT m.id, m.text, p.name AS to_name FROM messages m
       LEFT JOIN peers p ON p.id = m.to_id
       WHERE m.status = 'queued' AND m.notified = 0 AND m.sent_at < ?`
    )
    .all(cutoff) as { id: number; text: string; to_name: string | null }[];
  for (const m of stale) {
    const target = m.to_name ?? "unknown peer";
    const preview = m.text.slice(0, 80).replace(/["\\\n]/g, " ");
    Bun.spawn([
      "osascript",
      "-e",
      `display notification "${preview}" with title "claude-peers" subtitle "Message waiting for idle session: ${target}"`,
    ]);
    db.run("UPDATE messages SET notified = 1 WHERE id = ?", [m.id]);
  }
}

setInterval(notifyStaleMessages, 30_000);

// --- Request handlers ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  const host = (body.host || MY_HOST).toLowerCase();
  const machine = body.machine_id ?? "";
  const name = uniqueName(baseName(body));

  // Keep the friendly label consistent fleet-wide: a machine's label is
  // whatever its newest registration says (labels are display-only; the
  // machine_id is the identity).
  if (machine) {
    db.run("UPDATE peers SET host = ? WHERE machine_id = ? AND host != ?", [host, machine, host]);
  }

  // Re-registration: same MCP-server PID or same parent Claude process on
  // the SAME MACHINE (PIDs collide across machines) — matched by stable
  // machine_id, with a host-label fallback for pre-0.3.1 rows. Migrate
  // queued mail to the new identity.
  const existing = db
    .query(
      `SELECT id FROM peers WHERE
         (pid = ?1 OR (claude_pid IS NOT NULL AND claude_pid = ?2))
         AND (
           (?3 != '' AND machine_id = ?3)
           OR (machine_id = '' AND host = ?4)
         )`
    )
    .all(body.pid, body.claude_pid, machine, host) as { id: string }[];

  db.run(
    `INSERT INTO peers (id, name, pid, claude_pid, host, machine_id, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, body.pid, body.claude_pid, host, machine, body.cwd, body.git_root, body.tty, body.summary, now, now]
  );

  for (const old of existing) {
    db.run("UPDATE messages SET to_id = ? WHERE to_id = ? AND status = 'queued'", [id, old.id]);
    db.run("DELETE FROM peers WHERE id = ?", [old.id]);
  }

  return { id, name };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [new Date().toISOString(), body.id]);
}

function handleSetSummary(body: SetSummaryRequest): void {
  db.run("UPDATE peers SET summary = ? WHERE id = ?", [body.summary, body.id]);
}

function withPending(peers: Peer[]): Peer[] {
  return peers.map((p) => {
    const row = db
      .query("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND status = 'queued'")
      .get(p.id) as { n: number };
    return { ...p, pending: row.n };
  });
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "directory":
      peers = db.query("SELECT * FROM peers WHERE cwd = ?").all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = db.query("SELECT * FROM peers WHERE git_root = ?").all(body.git_root) as Peer[];
      } else {
        peers = db.query("SELECT * FROM peers WHERE cwd = ?").all(body.cwd) as Peer[];
      }
      break;
    case "machine":
    default:
      peers = db.query("SELECT * FROM peers").all() as Peer[];
  }

  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer is still alive (PID check locally, heartbeat freshness remotely)
  peers = peers.filter((p) => {
    if (peerAlive(p as unknown as { pid: number; host: string; last_seen: string })) return true;
    db.run("DELETE FROM peers WHERE id = ?", [p.id]);
    return false;
  });

  return withPending(peers);
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  // v1 compat: accept `to_id` as alias for `to`
  const to = body.to ?? (body as unknown as { to_id?: string }).to_id;
  if (!to) return { ok: false, error: "Missing 'to' (peer id or name)" };

  // Accept "id", "name", or "name@host"
  const [namePart, hostPart] = to.split("@");
  const target = (
    hostPart
      ? db
          .query(
            "SELECT id, name, host, last_seen FROM peers WHERE lower(name) = lower(?1) AND lower(host) = lower(?2)"
          )
          .get(namePart, hostPart)
      : db
          .query("SELECT id, name, host, last_seen FROM peers WHERE id = ?1 OR lower(name) = lower(?1)")
          .get(to)
  ) as { id: string; name: string; host: string; last_seen: string } | null;
  if (!target) {
    const names = (db.query("SELECT name, host FROM peers").all() as { name: string; host: string }[])
      .map((r) => `${r.name}@${r.host}`)
      .join(", ");
    return { ok: false, error: `Peer "${to}" not found. Known peers: ${names || "(none)"}` };
  }

  const result = db.run(
    "INSERT INTO messages (from_id, to_id, text, sent_at, delivered, status) VALUES (?, ?, ?, ?, 0, 'queued')",
    [body.from_id, target.id, body.text, new Date().toISOString()]
  );

  return {
    ok: true,
    message_id: Number(result.lastInsertRowid),
    to_id: target.id,
    to_name: target.name,
    target_last_seen: target.last_seen,
  };
}

/**
 * Atomically hand queued messages to the receiving session.
 * Called by delivery hooks at the moment the text is injected into context —
 * this is the only place messages transition queued → delivered.
 */
function handleConsume(body: ConsumeRequest): ConsumeResponse {
  const tx = db.transaction((peerId: string) => {
    const messages = db
      .query(
        `SELECT m.*, COALESCE(p.name, m.from_id) AS from_name,
                COALESCE(p.cwd, '') AS from_cwd, COALESCE(p.summary, '') AS from_summary
         FROM messages m LEFT JOIN peers p ON p.id = m.from_id
         WHERE m.to_id = ? AND m.status = 'queued' ORDER BY m.sent_at ASC`
      )
      .all(peerId) as DeliveredMessage[];
    const now = new Date().toISOString();
    for (const m of messages) {
      db.run("UPDATE messages SET status = 'delivered', delivered = 1, delivered_at = ? WHERE id = ?", [
        now,
        m.id,
      ]);
    }
    return messages;
  });
  return { messages: tx(body.peer_id) };
}

/**
 * Used by delivery hooks to figure out which peer their session is.
 * The hook walks its process ancestry; one of those PIDs is the Claude
 * process that also spawned the registered MCP server.
 */
function handleFindPeer(body: FindPeerRequest): { peer: Peer | null } {
  if (!body.claude_pids?.length) return { peer: null };
  const host = (body.host || MY_HOST).toLowerCase();
  const machine = body.machine_id ?? "";
  const placeholders = body.claude_pids.map(() => "?").join(",");
  // Machine scoping is required (PIDs collide across machines) but keyed on
  // the stable machine_id, NOT the friendly host label — labels can change
  // (config renames) and must never orphan a mailbox. Host equality remains
  // only as the fallback for rows from pre-0.3.1 clients.
  const peer = db
    .query(
      `SELECT * FROM peers WHERE claude_pid IN (${placeholders})
       AND (
         (? != '' AND machine_id = ?)
         OR (machine_id = '' AND host = ?)
       )
       LIMIT 1`
    )
    .get(...body.claude_pids, machine, machine, host) as Peer | null;
  return { peer };
}

function handleMessageStatus(body: MessageStatusRequest): MessageStatusResponse {
  const m = db
    .query(
      `SELECT m.status, m.sent_at, m.delivered_at, m.to_id, COALESCE(p.name, m.to_id) AS to_name
       FROM messages m LEFT JOIN peers p ON p.id = m.to_id WHERE m.id = ?`
    )
    .get(body.message_id) as
    | { status: "queued" | "delivered"; sent_at: string; delivered_at: string | null; to_id: string; to_name: string }
    | null;
  if (!m) return { found: false };
  return { found: true, ...m };
}

function handleUnregister(body: { id: string }): void {
  db.run("DELETE FROM peers WHERE id = ?", [body.id]);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: BIND,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        const count = (db.query("SELECT COUNT(*) AS n FROM peers").get() as { n: number }).n;
        return Response.json({ status: "ok", version: BROKER_VERSION, host: MY_HOST, peers: count });
      }
      return new Response(`claude-peers broker v${BROKER_VERSION}`, { status: 200 });
    }

    // Non-loopback requests must present the shared token (when configured).
    // Loopback stays exempt so local components work before config exists.
    const ip = server.requestIP(req)?.address ?? "";
    const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLoopback) {
      if (!TOKEN) {
        return Response.json({ error: "remote access disabled (no token configured)" }, { status: 403 });
      }
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/consume":
          return Response.json(handleConsume(body as ConsumeRequest));
        case "/find-peer":
          return Response.json(handleFindPeer(body as FindPeerRequest));
        case "/message-status":
          return Response.json(handleMessageStatus(body as MessageStatusRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        case "/poll-messages":
          // Deprecated v1 endpoint. v1 servers polled this every second and
          // marked mail delivered before anyone read it. Returning [] keeps
          // still-running v1 servers harmless; v2 hooks use /consume.
          return Response.json({ messages: [] });
        case "/shutdown":
          setTimeout(() => process.exit(0), 100);
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(
  `[claude-peers broker] v${BROKER_VERSION} host=${MY_HOST} listening on ${BIND}:${PORT} (db: ${DB_PATH}, token: ${TOKEN ? "set" : "none — loopback only"})`
);
