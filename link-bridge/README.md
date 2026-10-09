# link-bridge

A tiny MCP server (no dependencies, Node 18+) that lets coding-agent sessions on one machine — Claude Code, Codex, Qwen Code, anything that speaks MCP — find and message each other, and lets one session host and hand out work.

State is plain files under `~/.session-link` (override with `LINK_HOME`). Nothing leaves the machine.

## Tools

| Tool | What it does |
|---|---|
| `link_peers` | List the other running sessions (name, CLI, folder) |
| `link_tell` / `link_tellall` | Message one session (name or id prefix) or all |
| `link_inbox` | Read and clear what was sent to you; `wait_seconds` waits for something |
| `link_host` | Become the host (or stop) |
| `link_assign` | Host: give a task to a worker or `all` |
| `link_report` | Worker: send a task's result back |
| `link_board` | Host: show tasks; `clear` drops finished ones |
| `link_rename` | Host: rename a worker as listed here |

A worker only obeys tasks and renames from the registered host. Sessions that stop (or stop answering for 60s) leave the list.

## Add it to each CLI

```
claude mcp add link --scope user -e LINK_CLI=claude -- node /path/to/server.mjs
codex mcp add link --env LINK_CLI=codex -- node /path/to/server.mjs
qwen mcp add link node /path/to/server.mjs -e LINK_CLI=qwen --trust
```

Codex asks before each MCP call; for hands-off use add `default_tools_approval_mode = "approve"` under `[mcp_servers.link]` in `~/.codex/config.toml`.

## How a task reaches a worker

Other CLIs cannot be pushed to: a message sits in the worker's inbox until it calls `link_inbox`. So a worker session needs to be told to check, for example "wait for work with link_inbox (wait_seconds 100), do any task, then call link_report". Inside Claude Code the separate `session-link` plugin does push delivery between Claude sessions.

## Test

`node --test test.mjs` runs a fake Claude, Codex and Qwen session through find, message, host, assign, report, board, rename and leave.
