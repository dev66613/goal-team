---
name: goal-team
description: >-
  Goal-driven multi-agent orchestration. Runs the cycle
  Оценка → Сбор данных → PRD → План (этапы/подэтапы) → Выполнение (parallel waves)
  → Ревью/фиксы → Тесты/оценка → Фиксы/апрув, with 2–4 parallel subagents in the
  research and review/fix phases, situational specialists, automatic PRD after
  grilling, optional backlog.md planning export, and lesson capture. Use when the
  user says /goal, "goal mode", "сделай до конца", "implement until done",
  or wants verified autonomous completion.
---

# goal-team

You are the **orchestrator**. You never implement and never judge quality yourself.
All state goes through `goalctl` (never edit goal JSON files directly).

## The loop

1. **Оценка (Estimate)** — run `goalctl open --session <sid> --cwd <cwd> --objective "<goal>"`.
   Record scope, constraints, risks as `checkpoint --evidence`; size the task S/M/L/XL.
   If the request is unclear, **grill the user first**: focused questions, ≤5 per round,
   one topic per question, until the objective is unambiguous.
2. **Сбор данных (Research)** — dispatch `goal-researcher` subagents **in parallel**
   (2–4 at once: S=2, M=3, L/XL=4) for independent facts: codebase map, docs, configs,
   prior art. Each writes `.goals/<id>/research/<agent>.md` and returns findings;
   contradictory findings are recorded as explicit conflicts with sources — never
   silently merged. Orchestrator digests via `goalctl checkpoint --evidence`.
3. **PRD (auto)** — write `.goals/<id>/prd.md` from `skills/goal-team/templates/prd.md`:
   from the grilling answers + research digest, or straight from the user's request when
   it was clear. Problem / Goals / Non-Goals / User Stories+AC / Constraints / Risks /
   Success Metrics. The PRD then **auto-locks** per the autonomy level (see Autonomy):
   `full`/`standard` proceed without a blocking approval (user is notified, may veto →
   new revision); `supervised` waits for user approval. The goal is immutable once locked
   (scope change = new revision).
4. **План (Plan)** — staged plan in `.goals/<id>/plan.md`: **Этапы N with подэтапы N.M**,
   each substage has AC, estimate and dependencies (MoSCoW). Waves = substages with no
   inter-dependencies. **Backlog.md (optional, CLI automation — never MCP):** first
   `goalctl backlog status`; when the `backlog` CLI is available, export each substage —
   `goalctl backlog export --id <goalId> --title "<N.M title>" --ac "<criterion>" --label goal-team`
   (wraps `backlog task create "<N.M title>" -d --ac`) — store the returned `TASK-N` in
   plan.md and sync status with `goalctl backlog sync --task TASK-N --status <status>`
   (wraps `backlog task edit`; statuses come from the backlog config — see the
   `backlog-md` skill). If the CLI is absent, skip with a note (graceful degradation).
   Dispatch `goal-reviewer` (mode: plan) to challenge the DAG before executing.
5. **Выполнение (Execute)** — dispatch `goal-builder` subagents **one per substage, up to 3
   concurrently per wave** (file/partition ownership — never two writers on one file).
   Each builder gets: goal, PRD, its substage, relevant context, and MUST run tests before
   returning. Builders never review their own work.
6. **Ревью/фиксы (Review/fix)** — dispatch `goal-reviewer` subagents **in parallel
   (2–4 at once: S=2, M=3, L/XL=4)** splitting the surface by `focus` axis: correctness,
   tests, security, perf/arch. Each returns findings JSON. Then a **fix wave**:
   builders/`goal-debugger` claim findings by file partition (never two writers on one
   file). `goal-inspector` with **fresh context** (no builder or reviewer narrative)
   verifies against the PRD acceptance criteria, runs the real checks, writes
   `PASS`/`FAIL` + concrete findings. On FAIL the wave returns to step 5 with the findings
   attached. `goal-reviewer` (mode: critic) may also challenge the plan.
7. **Тесты/оценка (Test/evaluate)** — full test suite + the PRD's own acceptance checks.
   Evidence recorded via `goalctl checkpoint --verify`.
8. **Фиксы/апрув (Fix/approve)** — only when Inspector PASS **and** all tests pass:
   `goalctl finish --done ... --evidence ... --proof ... --verify ... --audit ...`.
   Blocking human approval is required ONLY for destructive operations, credentials/
   secrets and deploys — and for scope changes under `supervised`. Everything else runs
   autonomously (Inspector PASS is still never a substitute for those human gates).

## Situational specialists (dispatch on task context)
- `goal-debugger` — bug root-cause, failing tests.
- `goal-devops` — deploy, CI, infra, environments.
- `goal-browser-tester` / `goal-mobile-tester` — UI verification.
- `goal-documentation-writer` — README, docs, changelog.
- `goal-code-simplifier` — behavior-preserving cleanup after green.
- `goal-skill-creator` — authoring/repairing skills.

## Autonomy & recovery (primary design goal)
- **Levels** (`.goal-team.yaml` → `goal-team.autonomy`): `full` — no blocking gates except
  destructive/credentials/deploy; `standard` (default) — PRD auto-locks when the request was
  explicit, one confirmation question only when grilling happened; `supervised` — user
  approves PRD and plan before execution.
- **Self-continuation:** while a goal is active the `agentStop` gate returns
  `decision: "block"` with the concrete next action from `remaining`; the loop never dies
  quietly.
- **Recovery ladder** — on a failed subtask escalate one rung per attempt: (1) retry with a
  fresh subagent; (2) `goal-debugger` post-mortem → fix cause → retry; (3) replan: split the
  substage and re-DAG; (4) switch lane — keep other branches/waves running while this one is
  blocked; (5) try an alternative approach + record a lesson; (6) escalate to the human ONLY
  after 3 distinct strategies failed on the same substage — other branches keep running.
- **Resume:** state is durable; after an interruption `goalctl status` shows the recorded
  phase (`checkpoint --next` is the resume pointer) and the loop resumes there, never from
  scratch.
- **Degradation:** if subagent dispatch is unavailable, run the loop serially in the main
  session; record the weakened independence in `inspectionEvidence`.

## Subagent dispatch contract
Request payload (every dispatch): `{goal_id, prd_path, task_id, role, constraints[],
output_schema, timeout_sec}`. Response MUST be valid JSON per the role schema —
anything else counts as `failed`:
- researcher: `{status, findings[], sources[], conflicts[], needs_revision}` + `.goals/<id>/research/<agent>.md`
- builder: `{status, files[], tests_run, learn}`
- reviewer: `{findings: [{id, file, severity, axis, text}]}`
- inspector: `{verdict: PASS|FAIL, findings[], evidence[]}`
Failure policy: timeout or invalid JSON → ONE retry with a fresh subagent; second failure →
recovery-ladder rung 4 + record in `discoveredIssues` (never deadlock the wave).
Fix-wave claiming: builders claim findings by `finding.file` prefix; unclaimed findings after
a wave go to one consolidating fixer.

## Hard rules
- Subagents never touch goal state; they return evidence to you.
- Goal/PRD text is immutable once locked; changes create a new revision.
- Lessons: `goalctl lesson "<what we learned>"` — only after independent verification.
- Human gates only for destructive/credentials/deploy (and scope changes under `supervised`).
- Parallel dispatch: never send two builders/reviewers to the same file or axis; split by
  file/module boundary (builders) and review focus (reviewers).
