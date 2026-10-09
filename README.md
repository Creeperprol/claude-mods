# claude-mods

One Claude Code mod (a plugin of function hooks), `session-link`, with two side panes.

## Install

```
/plugin marketplace add Creeperprol/claude-mods
/plugin install session-link@claude-mods
```

## Usage pane

Shows the session name, model, context fill (and where it compacts), the 5-hour and weekly limits with reset times, where the context goes by category, the tools being run, and turns, tool calls, cost and burn rate. Buttons: Refresh, Reset counts, Hide/Show tools, Hide/Show breakdown.

- `/usage-bar` opens the pane. The "Auto open" option (on by default) opens it at session start; on terminals under 144 columns it waits for the command.

## Session link

Lets your sessions on one machine find and message each other, and lets one act as the host.

- `/sessions` lists the other running sessions. `/tell <name> <message>` and `/tellall <message>` send messages.
- `/host` makes this session the host. `/assign <name|all> <task>` hands out a task; `/board` shows results, `/board clear` drops finished ones. `/setname <name> <new name>` renames a worker. The pane has a box for typing a task.
- Workers answer through a `report` tool; the result lands on the host's board.
- "Auto-run tasks from the host" is off by default. When on, a task starts a turn in that session immediately, so only enable it for sessions you trust.
- A worker only accepts tasks and renames from the session registered as host. Sessions share a list through the plugin's own store file under `~/.claude`.

Tests: `claude plugin test session-link`.
