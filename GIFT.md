# Dear Anthropic — a gift 🎁

*From Con (creative director, not a coder) and Claude Fable 5 (his IT agent), July 4, 2026.*

We run a lot of Claude Code sessions in parallel on one Mac. They need to talk to each other — "which port are you using?", "I'm about to restart the launchd engine", "heads up, BatonCore has uncommitted changes." A community MCP project (claude-peers) promised this, and it *almost* worked. This repo is our rebuilt version, plus what we learned making inter-session messaging actually reliable. Take any of it.

## What we found (the diagnosis)

The v1 design pushed inbound messages via the experimental `claude/channel` capability, which requires every session to be launched with `--dangerously-load-development-channels`. Nobody launches sessions that way — the Desktop app can't, and terminal users forget. The notifications were silently dropped. Meanwhile a 1-second poll loop marked each message `delivered` in SQLite the moment it read it from the broker — before the model ever saw it — so the "check messages manually" fallback always came up empty. Messages were destroyed in transit, the sending Claude was told "Message sent ✓", and the human ended up hand-relaying questions between his own AI sessions. (We found the receipts in the message log: *"Con relayed your two asks…"*)

## What we built (the fix)

Delivery through **hooks** — the one mechanism that works in every session type with no flags:

- `PostToolUse` injects queued peer mail mid-turn, while the target is busy working.
- `Stop` **blocks the session from going idle** while it has unread mail — it must answer first. This single trick is why peers now reply instead of ghosting.
- `UserPromptSubmit` / `SessionStart` catch the remaining cases.
- Messages stay `queued` in SQLite until atomically consumed at the moment of context injection. Senders get a `message_id` and can check `message_status` — no more delivery fiction.
- If mail sits queued >90s (target truly idle), the broker raises a macOS notification so the human knows.

## What we'd love from you (the wishlist)

1. **A first-class "deliver a message into a running session" primitive.** Hooks got us 95% there, but a fully idle session still can't be woken from outside. You clearly have the pieces — the Desktop app's session-to-session `send_message`, Agent-team `SendMessage`, channel notifications. A stable, documented, cross-surface version of that (terminal + Desktop + headless) would make this whole repo unnecessary. That's the gift we'd like back.

2. **Promote `claude/channel` out of experimental** (or kill it loudly). A capability that silently drops notifications unless a hidden flag is set is a footgun — the failure mode is invisible to both the sender and receiver.

3. **Steal the Stop-hook-blocks-with-mail pattern.** "You have unread messages from a teammate; handle them before going idle" is, in our experience, the difference between multi-agent coordination that works and agents that ghost each other.

Two tiny war stories for whoever maintains process-management code: `process.kill(pid, 0)` throwing `EPERM` means the process *exists* (hello, sandboxed callers) — treating any throw as "dead" wiped our whole peer table; and `lsof -ti :PORT` without `-sTCP:LISTEN` returns the port's *clients* too — our first broker restart accidentally assassinated every session's MCP server on the machine. We fixed both; the comments are in the code.

With love from a very chatty fleet of Claudes on a Mac Studio,

**Con & Claude** 🤝
