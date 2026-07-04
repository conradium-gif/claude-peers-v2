/**
 * Fleet configuration for claude-peers.
 *
 * Loaded from ~/.claude-peers.json (env vars override). Absent file =
 * pure localhost mode, identical to v2 behavior.
 *
 * Example hub setup (machine pointing at a broker on an always-on server):
 *   { "broker_url": "http://100.x.y.z:7899", "token": "…", "host": "laptop" }
 *
 * Example hub server (the broker machine itself):
 *   { "bind": "100.x.y.z", "token": "…", "host": "ultra" }
 *
 * A config file lives per machine — NOT in the repo — because hooks and
 * GUI-spawned MCP servers on macOS don't reliably inherit shell env vars.
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface PeersConfig {
  broker_url?: string; // where clients (server.ts, hooks) reach the broker
  token?: string; // shared secret; required by the broker for non-loopback requests
  host?: string; // friendly machine label ("desktop", "laptop", "ultra")
  bind?: string; // broker only: address to listen on (default 127.0.0.1)
}

export function loadConfig(): PeersConfig {
  try {
    const raw = readFileSync(`${process.env.HOME}/.claude-peers.json`, "utf8");
    return JSON.parse(raw) as PeersConfig;
  } catch {
    return {};
  }
}

/**
 * Stable machine identity, independent of the friendly host label.
 *
 * The host label ("desktop") is display/addressing sugar and can change —
 * e.g. when a config file first sets it — and anything keyed on it breaks
 * for components that registered under the old label (real incident:
 * running sessions registered as the raw hostname, a later config renamed
 * the machine, and delivery hooks stopped finding their mailboxes).
 * This UUID is generated once, persisted, and never changes.
 */
export function machineId(): string {
  const p = `${process.env.HOME}/.claude-peers.machine-id`;
  try {
    const id = readFileSync(p, "utf8").trim();
    if (id) return id;
  } catch {
    // first run
  }
  const id = crypto.randomUUID();
  try {
    writeFileSync(p, id + "\n");
  } catch {
    // unwritable home — fall back to a per-process id (delivery degrades
    // to legacy host matching, nothing breaks)
  }
  return id;
}

export function shortHostname(): string {
  try {
    const out = Bun.spawnSync(["hostname", "-s"]).stdout;
    const name = new TextDecoder().decode(out).trim().toLowerCase();
    return name || "unknown";
  } catch {
    return "unknown";
  }
}

export function hostLabel(config: PeersConfig): string {
  return (config.host ?? process.env.CLAUDE_PEERS_HOST ?? shortHostname())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

export function brokerUrl(config: PeersConfig): string {
  const port = process.env.CLAUDE_PEERS_PORT ?? "7899";
  return (
    process.env.CLAUDE_PEERS_BROKER_URL ??
    config.broker_url ??
    `http://127.0.0.1:${port}`
  ).replace(/\/+$/, "");
}

export function isRemoteBroker(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h !== "127.0.0.1" && h !== "localhost" && h !== "::1";
  } catch {
    return false;
  }
}

export function authHeaders(config: PeersConfig): Record<string, string> {
  const token = process.env.CLAUDE_PEERS_TOKEN ?? config.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
