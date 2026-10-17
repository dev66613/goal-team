---
name: backlog-md
description: >-
  Backlog.md CLI task tracking for the goal-team loop and ad-hoc work. Use when
  the user says "backlog", "задачи", "task tracker", "board", or when goal-team
  phase 4 (План) exports staged substages for external tracking. Covers task
  lifecycle (create with AC/DoD, status sync, board, search, doctor) via the
  backlog CLI only — never MCP.
argument-hint: "[list|create|board|search|doctor] [query]"
user-invocable: true
disable-model-invocation: false
---

# backlog-md

Backlog.md is the durable task tracker. The `backlog` CLI is the ONLY integration
surface — by design this skill never uses `backlog mcp` (no MCP server).

## Preconditions

1. `backlog --version` works. If not, tell the user to install the Backlog.md CLI
   and stop — do not improvise another tracker.
2. Project root: `BACKLOG_CWD` if set, else the nearest dir with `backlog/config.yml`,
   else the default global project. `goalctl backlog status` prints what resolved.
3. Read state with `backlog task list --json` **always** — bare `backlog task list`
   opens a TUI/alternate buffer and hangs automation.

## Task lifecycle (the commands that matter)

```powershell
backlog task list --json                                  # read state (never the TUI)
backlog task create "<title>" -d "<description>" `        # create
  --ac "<acceptance criterion>" --dod "<done item>" -l "<labels>"
backlog task edit <TASK-N> -s "<status>"                  # status sync (statuses come
                                                          # from the project config —
                                                          # discover via backlog board)
backlog task edit <TASK-N> --notes "<implementation note>"
backlog board                                             # human overview (interactive)
backlog search "<query>"                                  # tasks + docs + decisions
backlog doctor                                            # duplicate/cycle diagnostics
backlog instructions <overview|task-creation|task-execution|task-finalization>
                                                          # official workflow guides
```

Flags verified 2026-10-17: `task create` accepts `-d/--description`, `--ac`
(repeatable), `--dod` (repeatable), `-s`, `-l`, `--priority`, `--type`, `--plan`,
`--notes`; `task edit` accepts `-s`, `-t`, `-d`, `-l`, `--notes`. Note: `backlog
task complete` was REMOVED in current versions — finalization is `task edit -s
Done` (then `task archive <id>` to tidy).

## Integration with the goal-team loop

In phase 4 (План) of `goal-team`, export each substage through goalctl — it wraps
the CLI and records the returned id into goal state:

```powershell
goalctl backlog status                                   # available? root? version?
goalctl backlog export --id <goalId> --title "4.2 <name>" --ac "<criterion>" --label goal-team
goalctl backlog sync --task TASK-N --status "In Progress" # as work moves
goalctl backlog sync --task TASK-N --status "Done"
```

`--dry-run` on export/sync prints the exact `backlog ...` command without running it.
If the `backlog` CLI is absent, skip the export with a note in the plan — the loop
must never block on the tracker (graceful degradation).

## Rules

- CLI only. Never configure or call `backlog mcp`.
- Statuses are configuration-dependent — never hard-code "Review"; discover them.
- One backlog task per plan substage; store the returned `TASK-N` in plan.md.
- `--json` in every automated read; TUI commands (`board`, bare `list`) are for humans.
- Titles/descriptions in ASCII when invoked from terminals (Cyrillic can corrupt in
  some terminal bridges); the tracker itself stores UTF-8 fine.
