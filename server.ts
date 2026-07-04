#!/usr/bin/env bun
/**
 * claude-peers MCP server (v2)
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 *
 * v2: inbound delivery is handled by Claude Code hooks (hooks/deliver.ts),
 * NOT by this process. v1 pushed messages over the experimental
 * `claude/channel` capability, which is silently dropped unless every
 * session is launched with --dangerously-load-development-channels — and
 * its poll loop marked messages delivered before anyone read them. Both
 * are gone. This server now only provides tools + registration/heartbeat.
 *
 * Setup (see README): register as a user-scoped MCP server, and add the
 * delivery hooks to ~/.claude/settings.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  SendMessageResponse,
  ConsumeResponse,
  MessageStatusResponse,
} from "./shared/types.ts";
import { getGitBranch } from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const EXPECTED_BROKER_VERSION = "0.2.0";

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function brokerVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return j.version ?? "0.1.0";
  } catch {
    return null;
  }
}

async function ensureBroker(): Promise<void> {
  const v = await brokerVersion();
  if (v === EXPECTED_BROKER_VERSION) {
    log("Broker already running");
    return;
  }

  if (v !== null) {
    // A broker from a different code version is running — replace it.
    // -sTCP:LISTEN matters: without it, lsof also lists CLIENTS with open
    // connections to the port (i.e. every other MCP server), and we'd kill
    // them all.
    log(`Broker version ${v} != ${EXPECTED_BROKER_VERSION}, replacing...`);
    Bun.spawnSync([
      "bash",
      "-c",
      `lsof -ti tcp:${BROKER_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null || true`,
    ]);
    await new Promise((r) => setTimeout(r, 400));
  }

  log("Starting broker daemon...");
  // nohup + & fully detaches the broker from this process group, so it
  // survives terminal closes and MCP server restarts.
  Bun.spawn(
    [
      "bash",
      "-c",
      `nohup '${process.execPath}' '${BROKER_SCRIPT}' >> "$HOME/.claude-peers-broker.log" 2>&1 &`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if ((await brokerVersion()) === EXPECTED_BROKER_VERSION) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myName: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code sessions on this machine can discover you and exchange messages with you.

How delivery works: messages from peers are injected into your context automatically by hooks — mid-turn (after a tool call), when you finish a turn, or when the user sends their next prompt. When you see a "📨 claude-peers" block, treat it like a coworker tapping you on the shoulder: reply promptly with send_message (use the sender's name), then continue your work.

Available tools:
- list_peers: Discover other sessions (each has a friendly name like "multi-baton")
- send_message: Send a message to a peer by name or ID. Queued until their session is next active; you get a message_id back.
- message_status: Check whether a message you sent has been delivered yet.
- set_summary: Describe what you're working on (visible to peers).
- check_messages: Manually pull any queued messages for you.

When you start working on something substantial, call set_summary so peers know what you're doing.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their name, ID, working directory, git repo, summary, and how many messages are queued for them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer (default). "directory" = same working directory. "repo" = same git repository.',
        },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by name or peer ID. The message is queued and injected into the target session the next time it is active (mid-turn, at turn end, or on its next user prompt). Returns a message_id you can check with message_status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string" as const,
          description: 'Target peer name (e.g. "multi-baton") or peer ID (from list_peers)',
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "message_status",
    description:
      "Check delivery status of a message you sent: 'queued' (target session hasn't been active yet) or 'delivered' (injected into their context).",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "number" as const,
          description: "The message_id returned by send_message",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually pull queued messages addressed to you. Normally hooks deliver messages automatically; this is a real fallback (messages stay queued until read).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = ((args as { scope?: string })?.scope ?? "machine") as
        | "machine"
        | "directory"
        | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return textResult(`No other Claude Code instances found (scope: ${scope}).`);
        }

        const lines = peers.map((p) => {
          const parts = [
            `Name: ${p.name}  (ID: ${p.id})`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          if (p.pending) parts.push(`Queued messages waiting for them: ${p.pending}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return textResult(
          `You are "${myName}" (ID: ${myId}). Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`
        );
      } catch (e) {
        return textResult(
          `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
          true
        );
      }
    }

    case "send_message": {
      const a = args as { to?: string; to_id?: string; message: string };
      const to = a.to ?? a.to_id;
      if (!myId) return textResult("Not registered with broker yet", true);
      if (!to) return textResult("Missing 'to' (peer name or ID)", true);
      try {
        const result = await brokerFetch<SendMessageResponse>("/send-message", {
          from_id: myId,
          to,
          text: a.message,
        });
        if (!result.ok) {
          return textResult(`Failed to send: ${result.error}`, true);
        }
        const ageMs = result.target_last_seen
          ? Date.now() - new Date(result.target_last_seen).getTime()
          : 0;
        const staleWarning =
          ageMs > 60_000
            ? ` Note: that peer was last seen ${Math.round(ageMs / 60_000)}m ago — its session may be gone.`
            : "";
        return textResult(
          `Message ${result.message_id} queued for "${result.to_name}". It will be injected into their context the next time their session is active; if they stay idle >90s, the user gets a macOS notification. Use message_status(${result.message_id}) to check delivery.${staleWarning}`
        );
      } catch (e) {
        return textResult(
          `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
          true
        );
      }
    }

    case "message_status": {
      const { message_id } = args as { message_id: number };
      try {
        const result = await brokerFetch<MessageStatusResponse>("/message-status", { message_id });
        if (!result.found) return textResult(`Message ${message_id} not found.`, true);
        if (result.status === "delivered") {
          return textResult(
            `Message ${message_id} → "${result.to_name}": DELIVERED at ${result.delivered_at} (injected into their context).`
          );
        }
        return textResult(
          `Message ${message_id} → "${result.to_name}": still QUEUED (sent ${result.sent_at}). Their session hasn't been active since you sent it.`
        );
      } catch (e) {
        return textResult(
          `Error checking status: ${e instanceof Error ? e.message : String(e)}`,
          true
        );
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) return textResult("Not registered with broker yet", true);
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return textResult(`Summary updated: "${summary}"`);
      } catch (e) {
        return textResult(
          `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
          true
        );
      }
    }

    case "check_messages": {
      if (!myId) return textResult("Not registered with broker yet", true);
      try {
        const result = await brokerFetch<ConsumeResponse>("/consume", { peer_id: myId });
        if (result.messages.length === 0) {
          return textResult("No new messages.");
        }
        const lines = result.messages.map(
          (m) => `From "${m.from_name}" (${m.from_cwd}, ${m.sent_at}):\n${m.text}`
        );
        return textResult(
          `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`
        );
      } catch (e) {
        return textResult(
          `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
          true
        );
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function main() {
  // 1. Ensure broker is running (and is the right version)
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  const branch = await getGitBranch(myCwd);

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);

  // Local, instant summary — no external API needed. Sessions overwrite
  // this with set_summary once they know what they're working on.
  const dirName = (myGitRoot ?? myCwd).split("/").filter(Boolean).pop() ?? "unknown";
  const initialSummary = branch ? `Working in ${dirName} (branch: ${branch})` : `Working in ${dirName}`;

  // 3. Register with broker. claude_pid (our parent) is how delivery hooks
  // running in the same session find our mailbox.
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    claude_pid: process.ppid || null,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  myName = reg.name;
  log(`Registered as peer "${myName}" (${myId})`);

  // 4. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 5. Heartbeat — also self-heals the broker if it dies
  let missedHeartbeats = 0;
  const heartbeatTimer = setInterval(async () => {
    if (!myId) return;
    try {
      await brokerFetch("/heartbeat", { id: myId });
      missedHeartbeats = 0;
    } catch {
      missedHeartbeats++;
      if (missedHeartbeats >= 2) {
        log("Broker unreachable, attempting restart...");
        try {
          await ensureBroker();
          // Re-register: the broker may have lost state or been replaced
          const reg = await brokerFetch<RegisterResponse>("/register", {
            pid: process.pid,
            claude_pid: process.ppid || null,
            cwd: myCwd,
            git_root: myGitRoot,
            tty: getTty(),
            summary: initialSummary,
          });
          myId = reg.id;
          myName = reg.name;
          missedHeartbeats = 0;
          log(`Re-registered as peer "${myName}" (${myId})`);
        } catch (e) {
          log(`Broker restart failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 6. Clean up on exit
  const cleanup = async () => {
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
