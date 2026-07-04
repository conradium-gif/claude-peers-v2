---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers (v2)

Peer discovery and reliable messaging between Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite message queue. Auto-launched (detached) by the MCP server. Messages stay `queued` until atomically consumed at injection time.
- `server.ts` — MCP stdio server, one per Claude Code instance. Registers (with parent Claude PID), heartbeats, exposes tools. Does NOT deliver inbound mail.
- `hooks/deliver.ts` — Delivery hook, wired into ~/.claude/settings.json on PostToolUse / Stop / UserPromptSubmit / SessionStart. Finds its session's mailbox via process ancestry, consumes queued mail, injects it as hook context (or blocks Stop until the session replies).
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Local git-context helpers (no external APIs).
- `cli.ts` — CLI utility for inspecting broker state.

## Gotchas (learned the hard way)

- `process.kill(pid, 0)`: only ESRCH means dead; EPERM means alive-but-unsignalable (sandboxes). See `processAlive()` in broker.ts.
- Killing the broker by port MUST use `lsof -ti tcp:7899 -sTCP:LISTEN` — without `-sTCP:LISTEN`, lsof also returns every client connected to the port (all sessions' MCP servers).
- Hooks are snapshotted at session start; running sessions don't pick up hook changes.
- v1's `/poll-messages` is kept as a deprecated endpoint returning `[]` so lingering v1 servers can't consume (destroy) queued mail.

## Running

```bash
# Normal usage: registered as user-scope MCP + hooks in ~/.claude/settings.json (see README)

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <name-or-id> <message>
bun cli.ts kill-broker
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
