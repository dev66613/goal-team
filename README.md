# goal-team

Cross-platform goal-driven multi-agent orchestration for Copilot CLI / VS Code Chat:
bun hooks + `goalctl` CLI + skills/agents. **No MCP server, no extension.**

Merged from three predecessors: `gabrimatic/copilot-goal-system` (durable goal state),
`gsemet/copilot-goal-skill` (Builder/Inspector discipline), `mubaidr/gem-team` (parallel
agent waves). See `docs/plans/2026-10-17-goal-team-plugin.md` for the full design.

## Install

Requires [bun](https://bun.sh) ≥ 1.4.

### As a marketplace plugin (recommended)

```
/plugin marketplace add dev66613/goal-team
/plugin install goal-team@goal-team-marketplace
```

VS Code / Insiders: add the marketplace via `chat.plugins.marketplaces` → `"dev66613/goal-team"`,
or **Chat: Install Plugin From Source** with `https://github.com/dev66613/goal-team`.

Marketplace index: `.github/plugin/marketplace.json` (owner `dev66613`, one entry `goal-team`
whose `source` is the repository root).

### With the installer (writes absolute paths)

```powershell
bun scripts/install.mjs
```

- Copies the runtime to `<COPILOT_HOME>/goal-team/` (default `~/.copilot/goal-team`).
- Registers `<COPILOT_HOME>/hooks/goal-team.json` in the **verified** Copilot hook-file
  schema (`command`/`bash`/`powershell` + `timeoutSec`, absolute paths — never `$HOME`,
  never bare `bash`, PowerShell vocabulary for Windows). One file is discovered by
  Copilot CLI **and** the VS Code / VS Code Insiders Copilot harness.
- Installs skills into `<COPILOT_HOME>/skills/` (`goal-team`, `backlog-md`) — the
  built-in user-scope skill location for Chat and CLI.
- Migrates away `mcpServers.goalSystem`, legacy `goal-context.sh` / `goal-system-vscode.json`
  hook files, inline goal hook entries in `settings.json`, and the verified legacy
  `skills/goal` (identity-checked before removal).
- Idempotent: safe to re-run; never marks files read-only.
- **After migrating, restart any open Copilot chat sessions** — long-lived hosts keep
  executing the hook list discovered at their session start, so a deleted legacy hook
  can raise a transient `MODULE_NOT_FOUND` until the session reloads. The error from a
  pre-migration session is not a sign of a leftover config; check the host's hook log
  (`GitHub Copilot Chat Hooks.log` → `Running:` lines) for the current state.

If the old **copilot-goal-system** VS Code extension is installed, uninstall it manually
(`code --uninstall-extension gabrimatic.copilot-goal-system`) — its functionality lives here now.

## The 8-phase loop

```
Оценка → Сбор данных → PRD → План → Выполнение → Ревью/фиксы → Тесты → Фиксы/апрув
```

1. **Оценка** — open the goal (`goalctl open`), size S/M/L/XL; grilling first if the
   request is unclear (≤5 questions per round).
2. **Сбор данных** — 2–4 parallel `goal-researcher` subagents (S=2, M=3, L/XL=4);
   conflicts recorded with sources, never silently merged.
3. **PRD (auto)** — `.goals/<id>/prd.md` from the template, generated from grilling
   answers or straight from the request; auto-locks per autonomy level.
4. **План** — staged plan (Этапы N / подэтапы N.M, each with AC, estimate, dependencies);
   optional export to backlog.md (`backlog task create "<N.M>" -d --ac`, then
   `backlog task edit <id> -s`). Skipped with a note when the `backlog` CLI is absent.
5. **Выполнение** — waves of independent substages, ≤3 `goal-builder` concurrently,
   strictly file-partitioned.
6. **Ревью/фиксы** — 2–4 parallel `goal-reviewer` (focus: correctness, tests, security,
   perf/arch) → fix wave (findings claimed by file prefix) → fresh-context `goal-inspector`.
7. **Тесты** — full suite + PRD acceptance checks (`goalctl checkpoint --verify`).
8. **Фиксы/апрув** — `goalctl finish` on Inspector PASS + green tests. Blocking human
   approval ONLY for destructive ops, credentials and deploys.

### Autonomy

`full` (no blocking gates except destructive/credentials/deploy) · `standard` (default:
PRD auto-locks on explicit requests; one question after grilling) · `supervised` (user
approves PRD and plan). Failures run a recovery ladder: retry → debug → replan → switch
lane → alternative approach → escalate to the human only after 3 distinct strategies.
State is durable; `goalctl status` resumes at the recorded phase.

## Agents

| Agent | Mode | Role |
|---|---|---|
| goal-orchestrator | primary | owns the loop, dispatches waves, never implements |
| goal-builder | subagent | TDD implementation of one substage; fix-wave claims |
| goal-inspector | subagent | fresh-context verification, PASS/FAIL + findings |
| goal-researcher | subagent | costed modes scan/question/audit/trace/deep |
| goal-reviewer | subagent | axes: mode/target/scope + focus (correctness/tests/security/perf_arch) |
| goal-debugger | subagent | root-cause analysis (situational) |
| goal-devops | subagent | deploy/CI/infra, rollback plans (situational) |
| goal-browser-tester | subagent | UI verification (situational) |
| goal-mobile-tester | subagent | mobile verification (situational) |
| goal-documentation-writer | subagent | docs/README/changelog (situational) |
| goal-code-simplifier | subagent | post-green behavior-preserving cleanup (situational) |
| goal-skill-creator | subagent | skill/agent authoring + contract validation (situational) |

Subagent roles are adapted (not copied) from gem-team's roster — see
`C:\Users\psyen\agent-team\.apm\agents\` (mubaidr/gem-team, MIT).

## goalctl — the only state API

```
goalctl open --session <sid> --cwd <cwd> --objective "<goal>"
goalctl status [--id <id> | --session <sid>]
goalctl checkpoint --id <id> [--done ...] [--evidence ...] [--verify ...] [--issue ...] [--next ...] [--blocker ...]
goalctl finish --id <id> --done ... --evidence ... --proof ... --verify ... --audit ...
goalctl close --id <id> --status cancelled
goalctl lesson "<verified lesson>"
goalctl backlog status                                   # backlog CLI availability/root
goalctl backlog export --id <id> --title "<N.M>" --ac "<c>" [--label ...] [--dry-run]
goalctl backlog sync --task TASK-N --status "<status>"   [--dry-run]
goalctl doctor
```

State lives in `~/.goal-team/state/` (override with `GOAL_TEAM_HOME`); per-goal
git-auditable artifacts in `.goals/<id>/` (PRD, plan, research notes).

## backlog.md (CLI automation — no MCP)

Backlog.md integrates through the `backlog` CLI only (this plugin never uses
`backlog mcp`). The `backlog-md` skill carries the workflow; `goalctl backlog`
is the automation surface used by the loop's phase 4 (План) and records the
returned `TASK-N` ids into goal state. If the CLI is missing, exports are
skipped with a note — the loop never blocks on the tracker.

## Config

`.goal-team.yaml` — namespaced under a `goal-team:` root key (avoids gem-team's
top-level collision if both are installed):

```yaml
goal-team:
  autonomy: standard   # full | standard | supervised
```

## Development

```powershell
bun test              # full suite
bun run check         # syntax/transpile check
bun scripts/e2e-sweep.mjs   # lifecycle payload sweep (10 events)
```

## Migration

| From | What happens |
|---|---|
| copilot-goal-system | installer removes `mcpServers.goalSystem`, `goal-context.sh` / `goal-system-vscode.json*` hook files, inline goal hooks in `settings.json`, `extensions/goal-system/`, and the identity-verified legacy `skills/goal`; VS Code extension `gabrimatic.copilot-goal-system` must be uninstalled manually (`code --uninstall-extension gabrimatic.copilot-goal-system`) |
| gsemet/copilot-goal-skill | goal workflow absorbed (immutability, Builder/Inspector, `[B]` commit markers) — remove the old skill folder |
| gem-team / agent-team | agent roster and wave orchestration adapted — `apm install` of gem-team can be removed |
