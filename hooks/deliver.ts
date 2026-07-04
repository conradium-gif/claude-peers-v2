#!/usr/bin/env bun
/**
 * claude-peers delivery hook (v2)
 *
 * Runs as a Claude Code hook on PostToolUse, Stop, UserPromptSubmit, and
 * SessionStart. Checks the broker for queued messages addressed to THIS
 * session and, if any exist, injects them into the session's context —
 * the only reliable delivery path that works in every Claude Code session
 * (terminal, Desktop app, headless) with no experimental flags.
 *
 * Delivery semantics per event:
 *   PostToolUse       → message appears mid-turn while the session is busy
 *   Stop              → blocks the session from going idle until it replies
 *   UserPromptSubmit  → message rides along with the user's next prompt
 *   SessionStart      → catches mail queued while the session was starting
 *
 * Messages are marked delivered (via atomic /consume) only here, at the
 * moment they actually enter the model's context.
 *
 * How the hook finds its own mailbox: the MCP server (server.ts) registers
 * with claude_pid = its parent Claude process. This hook walks its own
 * process ancestry; the shared Claude PID identifies the peer. If the peer
 * isn't registered (yet), we exit silently and mail stays queued.
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${BROKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // broker down — never break the session over mail
  }
}

function ancestorPids(): number[] {
  const pids: number[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    pids.push(pid);
    try {
      const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout;
      pid = parseInt(new TextDecoder().decode(out).trim(), 10);
      if (!pid || Number.isNaN(pid)) break;
    } catch {
      break;
    }
  }
  return pids;
}

function formatMessages(
  messages: { from_id: string; from_name: string; from_cwd: string; text: string; sent_at: string }[]
): string {
  const blocks = messages.map((m) => {
    const time = m.sent_at.slice(11, 16);
    const cwd = m.from_cwd ? ` (${m.from_cwd})` : "";
    return `── from "${m.from_name}"${cwd} at ${time} UTC ──\n${m.text}`;
  });
  const replyTo = messages[messages.length - 1];
  return (
    `📨 claude-peers: incoming message(s) from other Claude Code session(s) on this machine:\n\n` +
    blocks.join("\n\n") +
    `\n\nReply now using the mcp__claude-peers__send_message tool with to="${replyTo.from_name}" ` +
    `(or the sender's name shown above), then continue what you were doing. ` +
    `If a message doesn't need a reply, briefly acknowledge it to the user and move on.`
  );
}

async function main() {
  const raw = await Bun.stdin.text();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // no/invalid stdin — still try to deliver
  }
  const event = input.hook_event_name ?? process.argv[2] ?? "unknown";

  // Identify this session's peer via shared ancestor (the Claude process)
  const found = await post<{ peer: { id: string } | null }>("/find-peer", {
    claude_pids: ancestorPids(),
  });
  if (!found?.peer) return; // not a peers-registered session (or broker down)

  const consumed = await post<{
    messages: { from_id: string; from_name: string; from_cwd: string; text: string; sent_at: string }[];
  }>("/consume", { peer_id: found.peer.id });
  if (!consumed || consumed.messages.length === 0) return; // nothing queued → hook is a no-op

  const text = formatMessages(consumed.messages);

  switch (event) {
    case "Stop":
      // Block the stop: the session must handle the message before idling.
      console.log(JSON.stringify({ decision: "block", reason: text }));
      break;
    case "PostToolUse":
    case "UserPromptSubmit":
    case "SessionStart":
      console.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: event, additionalContext: text },
        })
      );
      break;
    default:
      // Unknown event type — plain stdout is surfaced as context for most events
      console.log(text);
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0) // never fail the hook — mail stays queued for the next event
);
