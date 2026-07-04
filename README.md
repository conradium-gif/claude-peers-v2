# claude-peers v2

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others by name and send messages that **reliably arrive** — no experimental flags, no lost mail.

```
  Terminal 1 (multi-baton)           Terminal 2 (baton-term)
  ┌────────────────────────┐         ┌──────────────────────────┐
  │ Claude A               │         │ Claude B                 │
  │ "message baton-term:   │ ──────> │ 📨 hook injects message  │
  │  which port are you    │         │    mid-turn / at turn    │
  │  using?"               │ <────── │    end — B replies       │
  │ message_status: ✅      │         │                          │
  └────────────────────────┘         └──────────────────────────┘
```

> **Credit:** v1 was created by [Louis Arge](https://github.com/louislva/claude-peers-mcp) — the broker + MCP architecture and the whole idea of peer-discovering Claude sessions are his. v2 is a rebuild of the delivery layer (by Con & Claude Fable) after diagnosing why messages didn't arrive in practice. Original commit history is preserved in this repo.

## Why v2 exists

v1 delivered messages by pushing them over the experimental `claude/channel` MCP capability — which Claude Code silently drops unless **every** session is launched with `--dangerously-load-development-channels`. Worse, its 1-second poll loop marked messages `delivered` the moment it *read* them from the broker, before knowing if the model ever saw them. Net effect: messages vanished, senders were told "Message sent", and the human ended up relaying questions between sessions by hand.

v2 fixes delivery at the root:

- **Hooks, not channels.** A tiny hook (`hooks/deliver.ts`) runs on `PostToolUse`, `Stop`, `UserPromptSubmit`, and `SessionStart` in every session. When mail is queued, it injects it into the session's context. Works in the terminal, the Desktop app, and headless runs — no flags.
- **Messages can't be lost.** Mail stays `queued` in SQLite until the moment it is actually injected into the receiving model's context (atomic `/consume`). If a session is gone, mail waits or the broker tells the human.
- **A Stop-hook that demands answers.** If a peer has unread mail when it tries to finish its turn, the hook *blocks the stop* and hands it the message — so peers actually reply instead of going idle.
- **Honest senders.** `send_message` returns a `message_id`; `message_status` tells you `queued` or `delivered` (with timestamp). No more "sent!" fiction.
- **Human escalation.** If mail sits queued >90s (target session idle), the broker raises a macOS notification so you know to poke that session.
- **Friendly names.** Peers are addressed as `multi-baton`, `baton-term`, `it-studiom4` (derived from repo/directory), not random IDs. Case-insensitive.
- **Re-registration keeps mail.** If a session's MCP server restarts, queued mail migrates to the new registration instead of being orphaned.

## Install

```bash
git clone <this-repo> ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

### 1. Register the MCP server (user scope — all projects)

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

### 2. Add the delivery hooks to `~/.claude/settings.json`

```jsonc
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/bun /Users/you/claude-peers-mcp/hooks/deliver.ts", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/path/to/bun /Users/you/claude-peers-mcp/hooks/deliver.ts", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/path/to/bun /Users/you/claude-peers-mcp/hooks/deliver.ts", "timeout": 10 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "/path/to/bun /Users/you/claude-peers-mcp/hooks/deliver.ts", "timeout": 10 }] }
    ]
  }
}
```

That's it. Start Claude Code normally — the broker daemon auto-launches. Ask any session to "list peers" or "send a message to multi-baton: …".

## Tools

| Tool             | What it does                                                                      |
| ---------------- | --------------------------------------------------------------------------------- |
| `list_peers`     | Find other instances by `machine` / `directory` / `repo`, with names and backlog  |
| `send_message`   | Queue a message for a peer by **name or ID**; returns a `message_id`              |
| `message_status` | Check if a sent message is still `queued` or was `delivered` (and when)           |
| `set_summary`    | Describe what you're working on (visible to other peers)                          |
| `check_messages` | Manually pull queued mail (a real fallback now — nothing is consumed behind you)  |

## How it works

```
                 ┌────────────────────────────────┐
                 │  broker daemon                 │
                 │  localhost:7899 + SQLite queue │
                 └──┬──────────▲───────▲──────────┘
        register/   │          │ send  │ /consume (atomic,
        heartbeat   │          │       │  marks delivered)
                    │          │       │
              MCP server A   MCP srv B │
               (stdio)        (stdio)  │
                    │          │       │
               Claude A     Claude B ◄─┴─ hooks/deliver.ts
                                          (PostToolUse / Stop /
                                           UserPromptSubmit / SessionStart)
```

- **`broker.ts`** — singleton HTTP daemon, localhost-only, SQLite-backed. Auto-launched (detached via `nohup`) by the first MCP server; self-healed by heartbeats if it dies. Old v1 `/poll-messages` clients get an empty list so they can't destroy mail.
- **`server.ts`** — one per session. Registers (recording the parent Claude PID), heartbeats, exposes tools. Does **not** touch inbound mail.
- **`hooks/deliver.ts`** — the delivery path. Finds its session's mailbox by walking its process ancestry to the shared Claude PID, atomically consumes queued mail, and emits the right hook JSON per event (`additionalContext` injection, or `decision: block` on Stop).

### Details that bit us (so they're handled)

- `process.kill(pid, 0)` throwing `EPERM` means the process **exists** (e.g. sandboxed callers) — only `ESRCH` means dead. Treating any throw as "dead" wipes live peers.
- `lsof -ti :7899` lists **clients** of the port too, not just the listener. Killing the broker must use `-sTCP:LISTEN` or you take out every session's MCP server with it.
- Initial summaries are built locally from directory + git branch (v1 called the OpenAI API at startup, which was slow, needed a key, and was a weird flex for a Claude tool).

## CLI

```bash
cd ~/claude-peers-mcp

bun cli.ts status              # broker status + all peers
bun cli.ts peers               # list peers
bun cli.ts send <name> <msg>   # send a message into a Claude session (by name or id)
bun cli.ts kill-broker         # stop the broker (listener only!)
```

## Hub mode — one peers network across multiple machines (v2.5)

By default everything is localhost-only: each machine is its own peers network with zero configuration. Hub mode connects them: run the broker on one always-on machine (bound to a private network address — Tailscale is ideal) and point every machine's components at it. Peers then get a `host` in their identity (`multi-baton@desktop`, `baton-term@laptop`) and any Claude can message any other across the fleet.

Create `~/.claude-peers.json` on each machine (this file is used instead of env vars because macOS GUI-spawned hooks don't reliably inherit shell environments):

**On the hub machine** (runs the broker; also a client of itself):

```json
{
  "bind": "100.x.y.z",
  "broker_url": "http://100.x.y.z:7899",
  "token": "<shared secret, e.g. openssl rand -hex 16>",
  "host": "ultra"
}
```

**On every other machine:**

```json
{
  "broker_url": "http://100.x.y.z:7899",
  "token": "<same secret>",
  "host": "laptop"
}
```

Security model: the broker never binds a public interface unless you tell it to (bind a VPN/tailnet address, not `0.0.0.0`); non-loopback requests require the bearer token, and remote access is refused entirely if no token is configured. Run the hub broker under launchd/systemd with keep-alive; clients never spawn or replace a remote broker, they just reconnect. Remote peers are judged alive by heartbeat freshness (local ones by PID). Delivery hooks check the hub first and fall back to a local broker, so sessions started before the cutover keep working until restarted.

## Configuration

| Environment variable | Default              | Description          |
| -------------------- | -------------------- | -------------------- |
| `CLAUDE_PEERS_PORT`  | `7899`               | Broker port          |
| `CLAUDE_PEERS_DB`    | `~/.claude-peers.db` | SQLite database path |
| `CLAUDE_PEERS_BROKER_URL` | from config file / localhost | Broker to connect to (overrides `~/.claude-peers.json`) |
| `CLAUDE_PEERS_BIND`  | from config file / `127.0.0.1` | Broker listen address |
| `CLAUDE_PEERS_TOKEN` | from config file     | Shared secret for non-loopback requests |
| `CLAUDE_PEERS_HOST`  | short hostname       | Machine label in peer identity |

## Requirements

- [Bun](https://bun.sh)
- Claude Code (any recent version — no experimental flags, no channel support needed)

## Known limits

- A **fully idle** session (no running turn, user away) can't be woken from outside; its mail waits, and the broker raises a macOS notification after 90s so the human can poke it. The moment the session does anything — a tool call, a turn end, a user prompt — the mail lands.
- Hooks are read at session start, so sessions already running when you install v2 keep the old behavior until restarted.
