# goal-team Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace three overlapping plugins (copilot-goal-system, gsemet/copilot-goal-skill, gem-team/agent-team) with one cross-platform `goal-team` plugin: bun-based hooks + goalctl CLI + skills/agents (no MCP, no extension), with parallel multi-agent waves running an evaluation→research→PRD→plan→execute→review/fix→test→approve loop.

**Architecture:** Single-writer orchestrator owns all goal state (`.goals/<id>/` git-auditable files + `~/.goal-team/state/` durable JSON with locks). A bun hook (`hooks/goal-hook.mjs`) injects compact goal context into every CLI event and enforces drift/completion gates fail-open. `bin/goalctl.mjs` is the only mutation API (used by agents as a CLI, replacing the goalSystem MCP server). Parallel work is a dependency DAG of tasks dispatched in waves (max 3 concurrent builders) to Builder/Researcher/Tester subagents; the research and review/fix phases run 2–4 parallel subagents each (scaled by task size); an automatic PRD (after user grilling or straight from the request) is the immutable scope contract; planning is staged (этапы/подэтапы) with optional backlog.md CLI export; a situational specialist pack (debugger, devops, browser/mobile testers, doc writer, code simplifier, skill creator) is dispatched on context; an independent Inspector with fresh context gates each wave; lessons are promoted only after independent verification.

**Tech Stack:** Bun ≥1.4 (runtime, test runner `bun:test`, `Bun.spawn`), plain ESM JavaScript (no npm deps), YAML frontmatter agent/skill markdown for Copilot CLI/VS Code Chat, `plugin.json` for CLI plugin discovery.

**Cross-platform hard rules** (learned from fixing 1.1.23 — violations here are real bugs on this machine):
- Never invoke bare `bash` from tests or product code: on Windows `bash` = WSL launcher, mangles `\` paths. Use `tests/helpers/bash-runner.cjs` pattern (Git bash + `/c/...` paths) or avoid shell entirely (bun scripts run directly).
- Never assert POSIX file modes (`0o600/0o700/0o755`) on Windows; gate via `process.platform !== "win32"`.
- `os.homedir()` ignores `$HOME` on Windows; tests must set both `HOME` and `USERPROFILE`, or use an explicit `GOAL_TEAM_HOME` override.
- jq regex `\b` does not match through `--arg` (jq 1.8.x) and unescaped `[` breaks compilation; this plan uses **bun** for all regex work instead of jq — no jq dependency at all.
- Git bash MSYS rewrites argv looking like POSIX paths (`/goal…` → `C:/Program Files/Git/goal…`); the bun hook reads JSON from stdin, never argv paths.
- Never edit files via `powershell.exe` (5.1) `Get-Content`/`Set-Content` round-trips — CP1251 corrupts non-ASCII. Use `pwsh` (7.x) or bun/node file APIs.
- Windows path compare: lowercase before hashing cwd for index keys (the D9 orphan bug).

---
## Epic & User Stories (INVEST · MoSCoW)

**Epic: goal-team — единый кроссплатформенный goal-плагин** (merged from copilot-goal-system + gsemet/copilot-goal-skill + gem-team/agent-team). Points use the 1/2/3/5/8/13 scale; no story exceeds 13 (nothing needs splitting).

| # | Story | Pts | Size | MoSCoW | Business | Depends on | Task |
|---|-------|-----|------|--------|----------|------------|------|
| US-1 | Параллельный сбор данных (2–4 research-субагента) | 5 | S | Must | High | US-6 | 4 |
| US-2 | Мультиагентское ревью/фиксы (2–4 reviewer + fix-wave) | 8 | M | Must | High | US-6 | 4 |
| US-3 | Авто-PRD после grilling или из запроса | 5 | S | Must | High | US-6 | 4 |
| US-4 | План этапами/подэтапами + backlog.md CLI экспорт | 5 | S | Must (экспорт — Should) | Medium | US-3 | 4 |
| US-5 | Ситуативные субагенты (7 спецов по образцу gem-team) | 3 | XS | Must | Medium | US-6 | 4 |
| US-6 | Ядро: store (fix D6/D9) + bun-hook + goalctl + инсталлер без MCP | 13 | L | Must | High | — | 0–3, 5–7 |

### US-1: Параллельный сбор данных
**As a** разработчик, **I want** фазу «Сбор данных» с 2–4 параллельными research-субагентами, **so that** факты собираются независимо, быстро и с проверяемыми источниками.
**AC:**
- Given размер задачи S/M/L/XL When оркестратор открывает фазу Then запускаются 2/3/4/4 субагента параллельно
- Given субагент вернул findings Then они лежат в `.goals/<id>/research/<agent>.md` + `goalctl checkpoint --evidence`
- Given противоречивые findings Then оба варианта записываются с источниками (явный конфликт, не тихое слияние)
**Estimation:** 5 pts · **Depends on:** US-6 · **Priority:** Must / High

### US-2: Мультиагентское ревью/фиксы
**As a** разработчик, **I want** фазу «Ревью/фиксы» с 2–4 параллельными reviewer-субагентами и волной фиксеров, **so that** дефекты ловятся независимо, а фиксы не конфликтуют.
**AC:**
- Given размер S/M/L/XL Then ревью идёт 2/3/4/4 осями параллельно (correctness, +tests, +security, +perf/arch)
- Given findings JSON от всех reviewer Then фиксеры разбирают их по файловым партициям (никогда два писателя на один файл)
- Given волна фиксов завершена Then `goal-inspector` (fresh context) выносит PASS/FAIL; FAIL возвращает волну в «Выполнение» с findings
**Estimation:** 8 pts · **Depends on:** US-6 · **Priority:** Must / High

### US-3: Автоматический PRD
**As a** пользователь, **I want** автоматический PRD после grilling или прямо из запроса, **so that** цель и scope зафиксированы до планирования.
**AC:**
- Given неясный запрос When фаза «Оценка» Then оркестратор грилит пользователя (≤5 вопросов за раунд, одна тема на вопрос) и генерирует PRD из ответов
- Given ясный запрос When фаза «Оценка» Then PRD генерируется прямо из запроса
- Then `.goals/<id>/prd.md` собран по шаблону: Problem / Goals / Non-Goals / User Stories+AC / Constraints / Risks / Success Metrics
- Given PRD зафиксирован Then цель иммутабельна; смена scope = новая ревизия; блокирующий апрув нужен только для destructive/credentials/deploy (см. уровни автономности) — при явном запросе PRD фиксируется без блокировки и работа продолжается
**Estimation:** 5 pts · **Depends on:** US-6 · **Priority:** Must / High

### US-4: План этапами/подэтапами + backlog.md
**As a** пользователь, **I want** план с этапами и подэтапами и опциональный экспорт в backlog.md CLI, **so that** план трекается снаружи, когда это нужно.
**AC:**
- Given фаза «План» Then `plan.md` содержит Этапы N и подэтапы N.M, каждый с AC, оценкой и зависимостями (MoSCoW)
- Given `backlog` CLI доступен Then каждый подэтап экспортируется `backlog task create "<N.M>" -d "<AC/оценка/зависимости>" --ac "<критерий>"`, id пишется в plan.md
- Given статус работы изменился Then `backlog task edit <id> -s <status>` (статусы — из конфигурации backlog)
- Given CLI отсутствует Then экспорт пропускается с пометкой (graceful degradation)
**Estimation:** 5 pts · **Depends on:** US-3 · **Priority:** Must / Medium (само построение плана — Must; экспорт backlog — Should, «с возможностью»)

### US-5: Ситуативные субагенты
**As a** оркестратор, **I want** пакет ситуативных спецов, **so that** типовые работы делегируются профильным агентам без переизобретения.
**AC:**
- Given контекст задачи Then оркестратор делегирует: баги/упавшие тесты→`goal-debugger`, деплой/CI→`goal-devops`, UI→`goal-browser-tester`, мобайл→`goal-mobile-tester`, доки→`goal-documentation-writer`, пост-грин чистка→`goal-code-simplifier`, правка скиллов→`goal-skill-creator`
- Then все 12 агентов (5 core + 7 situational) проходят контракт-тест frontmatter/JSON
**Estimation:** 3 pts · **Depends on:** US-6 · **Priority:** Must / Medium

### US-6: Ядро (базовый контур)
**As a** пользователь, **I want** durable goal-state + bun-хук + goalctl + инсталлер без MCP/extension, **so that** плагин работает кроссплатформенно и мигрирует с трёх старых.
**AC:** покрыто тестами задач 0–3 и 5–7: локи, D6 replace-semantics, D9 case-insensitive cwd-хеш, drift-gate fail-open, миграция удаляет `mcpServers.goalSystem`, инсталлер идемпотентен и не ставит read-only, изоляция `GOAL_TEAM_HOME`.
**Estimation:** 13 pts · **Depends on:** — · **Priority:** Must / High

## Стадии и подэтапы (эпик → задачи)

| Стадия | Подэтапы | Stories | Волна |
|---|---|---|---|
| Task 0 Scaffold | 0.1 manifest · 0.2 bun:test harness | US-6 | 1 |
| Task 1 goal-store | 1.1 locks · 1.2 replace-fields (D6) · 1.3 cwd-hash (D9) | US-6 | 1 |
| Task 2 bun hook | 2.1 stdin JSON contract · 2.2 drift/completion gates | US-6 | 1 |
| Task 3 goalctl | 3.1 open/status · 3.2 checkpoint/finish · 3.3 lesson/doctor | US-6 | 1 |
| Task 4 Skills+agents | 4.1 PRD-шаблон · 4.2 SKILL (8 фаз) · 4.3 core-5 · 4.4 situational-7 · 4.5 backlog-экспорт | US-1…US-5 | 2 |
| Task 5 Lessons | 5.1 seed-уроки из фикс-сессии 1.1.23 (параллельно с Task 4) | US-6 | 2 |
| Task 6 Installer | 6.1 миграция (удаление MCP) · 6.2 идемпотентность | US-6 | 3 |
| Task 7 E2E+docs | 7.1 payload sweep · 7.2 README · 7.3 изоляция | все | 3 |

**Atomicity rule:** Step внутри Task — атомарная единица (3–30 мин, один TDD-цикл = один коммит); подэтапы таблицы ↔ коммиты. Заблокированная ветка не тормозит волну: остальные подэтапы продолжаются (см. Autonomy → Recovery ladder).
**Definition of Done:** `bun test` green, `bun run check` exit 0, записи только внутри `GOAL_TEAM_HOME`, backlog-статусы синхронизированы (если экспорт включён).
**Task board mapping (backlog.md):** статусы берутся из конфигурации backlog (обычно To Do / In Progress / Done): план→To Do, работа→In Progress, ревью→настроенный review-статус (если есть), апрув→Done.

---
## Task 0: Scaffold repo + test harness

**Files:**
- Create: `goal-team/package.json`, `goal-team/plugin.json`, `goal-team/.gitignore`, `goal-team/tests/helpers/env.cjs`
- Test: `goal-team/tests/scaffold.test.mjs`

**Step 1: Write the failing test**

```js
// tests/scaffold.test.mjs
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

test("plugin manifest declares skills, agents and hooks", () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + "/../plugin.json", "utf8"));
  expect(pkg.name).toBe("goal-team");
  expect(pkg.skills).toBe("skills/");
  expect(pkg.hooks).toBe("hooks.json");
});

test("bun test runner works cross-platform", () => {
  expect(process.platform === "win32" || process.platform === "linux" || process.platform === "darwin").toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `cd goal-team && bun test tests/scaffold.test.mjs`
Expected: FAIL — `error: Could not read .../plugin.json`

**Step 3: Write minimal implementation**

```json
// goal-team/package.json
{
  "name": "goal-team",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Cross-platform goal-driven multi-agent orchestration: bun hooks + goalctl CLI + skills (no MCP, no extension).",
  "license": "MIT",
  "scripts": {
    "test": "bun test",
    "check": "bun build --no-bundle hooks/goal-hook.mjs bin/goalctl.mjs lib/goal-store.mjs --outdir /tmp/goal-team-check >/dev/null",
    "doctor": "bun bin/goalctl.mjs doctor"
  }
}
```

```json
// goal-team/plugin.json
{
  "name": "goal-team",
  "version": "0.1.0",
  "description": "Goal-driven multi-agent orchestration with parallel waves, independent verification, and lessons.",
  "skills": "skills/",
  "hooks": "hooks.json",
  "agents": "agents/"
}
```

```gitignore
# goal-team/.gitignore
node_modules/
*.log
```

**Step 4: Run test to verify it passes**

Run: `cd goal-team && bun test`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
cd goal-team && git init -b main && git add -A
git commit -m "chore: scaffold goal-team plugin with bun test harness"
```

---

## Task 1: goal-store — durable state with locks (fixes D6+D9)

**Files:**
- Create: `goal-team/lib/goal-store.mjs`
- Test: `goal-team/tests/goal-store.test.mjs`
- Helper: `goal-team/tests/helpers/env.cjs`

**Step 1: Write the failing tests** (covers the two real bugs from 1.1.23)

```js
// tests/helpers/env.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");
// os.homedir() ignores $HOME on Windows, so tests isolate via an explicit override instead.
function tempHome(prefix) {
  return require("node:fs").mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
}
module.exports = { tempHome };
```

```js
// tests/goal-store.test.mjs
import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import { GoalStore, hashCwd } from "../lib/goal-store.mjs";
import path from "node:path";

let store, home;
beforeEach(async () => {
  home = tempHome("goal-team-store");
  store = new GoalStore({ stateRoot: path.join(home, "state") });
  await store.init();
});

test("hashCwd is case-insensitive on win32 (D9 orphan fix)", () => {
  const a = hashCwd("C:\\Users\\Me\\project");
  const b = hashCwd("c:\\users\\me\\project");
  expect(a).toBe(b);
});

test("open creates goal and indexes by session and cwd-session", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "ship it" });
  expect(g.status).toBe("active");
  expect((await store.loadBySession("s1")).id).toBe(g.id);
  expect((await store.loadByCwdSession("/w/p", "s1")).id).toBe(g.id);
});

test("checkpoint REPLACES discoveredIssues instead of appending (D6 orphan fix)", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "ship it" });
  await store.checkpoint(g.id, { discoveredIssues: ["issue A", "issue B"] });
  await store.checkpoint(g.id, { discoveredIssues: ["issue B reworded"] });
  const after = await store.load(g.id);
  expect(after.discoveredIssues).toEqual(["issue B reworded"]);
});

test("append-mode fields still accumulate", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "ship it" });
  await store.checkpoint(g.id, { doneSoFar: ["step 1"] });
  await store.checkpoint(g.id, { doneSoFar: ["step 2"] });
  expect((await store.load(g.id)).doneSoFar).toEqual(["step 1", "step 2"]);
});

test("close resolves every index record for the session (no orphans)", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "ship it" });
  await store.close(g.id, { status: "complete" });
  expect(await store.loadBySession("s1")).toBe(null);
  expect(await store.loadByCwdSession("/w/p", "s1")).toBe(null);
});

test("finish refuses when remaining work is recorded", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "ship it" });
  await store.checkpoint(g.id, { remaining: ["do the thing"] });
  expect(() => store.finish(g.id, { doneSoFar: ["x"], evidence: ["e"], proof: ["p"], verify: ["v"], audit: ["a"] }))
    .toThrow(/remaining/i);
});

test("concurrent checkpoints do not lose entries", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "ship it" });
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    store.checkpoint(g.id, { doneSoFar: [`entry ${i}`] })));
  expect((await store.load(g.id)).doneSoFar.length).toBe(8);
});

test("open is idempotent per session (second open returns the active goal)", async () => {
  const a = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "one" });
  const b = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "two" });
  expect(b.id).toBe(a.id);
  expect(b.objective).toBe("one");
});

test("bumpDrift counts tool calls and checkpoint resets the counter", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "x" });
  await store.bumpDrift(g.id);
  await store.bumpDrift(g.id);
  expect((await store.load(g.id)).drift).toBe(2);
  await store.checkpoint(g.id, { doneSoFar: ["ok"] });
  expect((await store.load(g.id)).drift).toBe(0);
});

test("finish clears session indexes so a new goal can start (no stale active)", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "x" });
  await store.finish(g.id, { doneSoFar: ["d"], evidence: ["e"], proof: ["p"], verify: ["v"], audit: ["a"] });
  expect((await store.load(g.id)).status).toBe("complete");
  expect(await store.loadBySession("s1")).toBe(null);
  expect(await store.loadByCwdSession("/w/p", "s1")).toBe(null);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd goal-team && bun test tests/goal-store.test.mjs`
Expected: FAIL — module `../lib/goal-store.mjs` not found (10 failures)

**Step 3: Write minimal implementation**

```js
// lib/goal-store.mjs
import { mkdir, readFile, writeFile, readdir, rm, rename, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export function hashCwd(cwd) {
  // Windows paths are case-insensitive: normalise before hashing or one cwd yields
  // two index slots (orphan-record bug in 1.1.23).
  const key = process.platform === "win32" ? String(cwd).toLowerCase() : String(cwd);
  return createHash("sha1").update(key).digest("hex");
}

const APPEND_FIELDS = new Set([
  "requirements", "mustNotRegress", "constraints", "evidence", "inspectionEvidence",
  "validationProof", "verificationResults", "requirementCoverage", "doneSoFar",
  "completionAudit", "resolvedIssues",
]);
const REPLACE_FIELDS = new Set(["remaining", "blockers", "discoveredIssues"]);
const LOCK_STALE_MS = 10_000;

export class GoalStore {
  constructor({ stateRoot }) {
    this.root = stateRoot;
    this.goals = path.join(stateRoot, "goals");
    this.bySession = path.join(stateRoot, "by-session");
    this.byCwd = path.join(stateRoot, "by-cwd-session");
    this.locks = path.join(stateRoot, "locks");
    this.lessons = path.join(stateRoot, "lessons.md");
  }
  async init() {
    for (const d of [this.goals, this.bySession, this.byCwd, this.locks]) await mkdir(d, { recursive: true });
  }
  goalPath(id) { return path.join(this.goals, `${id}.json`); }
  sessionPath(sid) { return path.join(this.bySession, `${sid}.json`); }
  cwdPath(cwd, sid) { return path.join(this.byCwd, `${hashCwd(cwd)}--${sid}.json`); }

  async withLock(id, fn) {
    const p = path.join(this.locks, `${id}.lock`);
    for (let i = 0; i < 40; i++) {
      try {
        const h = await open(p, "wx");
        try { return await fn(); } finally { await h.close(); await rm(p, { force: true }); }
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const st = await import("node:fs/promises").then(m => m.stat(p).catch(() => null));
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await rm(p, { force: true });
        await Bun.sleep(50);
      }
    }
    throw new Error(`lock timeout for ${id}`);
  }

  async load(id) { return JSON.parse(await readFile(this.goalPath(id), "utf8")); }
  async loadBySession(sid) { return this.#loadOptional(this.sessionPath(sid)); }
  async loadByCwdSession(cwd, sid) { return this.#loadOptional(this.cwdPath(cwd, sid)); }
  async #loadOptional(p) {
    try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
  }

  async #writeGoal(goal) {
    const json = JSON.stringify(goal, null, 2);
    await writeFile(this.goalPath(goal.id), json);
    await writeFile(this.sessionPath(goal.sessionId), json);
    await writeFile(this.cwdPath(goal.cwd, goal.sessionId), json);
    return goal;
  }

  async open({ sessionId, cwd, objective }) {
    return this.withLock(sessionId, async () => {
      // Idempotent per session: a second /goal must not orphan the first goal's index.
      const existing = await this.#loadOptional(this.sessionPath(sessionId));
      if (existing && existing.status === "active") return existing;
      const goal = {
        id: randomUUID(), sessionId, cwd, objective,
        status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        drift: 0,
        discoveredIssues: [], resolvedIssues: [], remaining: [], blockers: [],
        doneSoFar: [], evidence: [], inspectionEvidence: [], validationProof: [],
        verificationResults: [], requirementCoverage: [], completionAudit: [],
        history: [],
      };
      return this.#writeGoal(goal);
    });
  }

  async checkpoint(id, patch) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      for (const [k, v] of Object.entries(patch)) {
        if (!Array.isArray(v)) continue;
        if (APPEND_FIELDS.has(k)) goal[k] = [...new Set([...(goal[k] || []), ...v])];
        else if (REPLACE_FIELDS.has(k)) goal[k] = [...new Set(v)];
      }
      goal.updatedAt = new Date().toISOString();
      goal.drift = 0; // a checkpoint resets the drift counter (hook bumps it per tool call)
      return this.#writeGoal(goal);
    });
  }

  // Drift accounting: tool calls since the last checkpoint.
  async bumpDrift(id) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      goal.drift = (goal.drift || 0) + 1;
      return this.#writeGoal(goal);
    });
  }

  async finish(id, patch) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      if ((goal.remaining || []).length && !patch.clearRemaining) {
        throw new Error(`finish refused: remaining work still recorded (${goal.remaining.length} items)`);
      }
      for (const [k, v] of Object.entries(patch)) {
        if (!Array.isArray(v)) continue;
        if (APPEND_FIELDS.has(k)) goal[k] = [...new Set([...(goal[k] || []), ...v])];
        else if (REPLACE_FIELDS.has(k)) goal[k] = [...new Set(v)];
      }
      goal.status = "complete";
      goal.closedAt = goal.updatedAt = new Date().toISOString();
      await this.#writeGoal(goal);
      // A finished goal must not linger in the "active" indexes (D9-style orphan) —
      // otherwise the hook would block a fresh goal in the same session.
      for (const p of [this.sessionPath(goal.sessionId), this.cwdPath(goal.cwd, goal.sessionId)]) {
        await rm(p, { force: true });
      }
      return goal;
    });
  }

  async close(id, { status }) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      goal.status = status;
      goal.closedAt = goal.updatedAt = new Date().toISOString();
      await this.#writeGoal(goal);
      // remove every index record so no stale "active" copy survives (D9)
      for (const p of [this.sessionPath(goal.sessionId), this.cwdPath(goal.cwd, goal.sessionId)]) {
        await rm(p, { force: true });
      }
      return goal;
    });
  }

  async lesson(text) {
    await writeFile(this.lessons, `## ${new Date().toISOString()}\n${text}\n\n`, { flag: "a" });
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd goal-team && bun test tests/goal-store.test.mjs`
Expected: PASS (10 tests)

**Step 5: Commit**

```bash
git add lib/goal-store.mjs tests/
git commit -m "feat: goal-store with lock, replace-semantics and case-insensitive cwd index"
```

---

## Task 2: bun hook — context injection + drift gate (replaces bash goal-context.sh)

**Files:**
- Create: `goal-team/hooks/goal-hook.mjs`, `goal-team/hooks.json`
- Test: `goal-team/tests/goal-hook.test.mjs`

**Step 1: Write the failing test**

```js
// tests/goal-hook.test.mjs
import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import path from "node:path";

let env;
beforeEach(() => {
  const home = tempHome("goal-team-hook");
  // os.homedir() ignores $HOME on Windows — set both.
  env = { ...process.env, GOAL_TEAM_HOME: path.join(home, "state-home"), HOME: home, USERPROFILE: home };
});

async function runHook(payload, extra = {}) {
  const proc = Bun.spawn(["bun", "hooks/goal-hook.mjs"], {
    cwd: import.meta.dir + "/..",
    env: { ...env, ...extra },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload)); proc.stdin.end();
  const out = await proc.stdout.text();
  return { code: await proc.exited, out: out.trim() };
}

test("UserPromptSubmitted with /goal creates a draft and reports it", async () => {
  const { code, out } = await runHook({ hook_event_name: "UserPromptSubmitted", session_id: "s1", cwd: "/w/p", prompt: "/goal make tests green" });
  expect(code).toBe(0);
  expect(JSON.parse(out).additionalContext).toContain("draft goal");
});

test("malformed stdin never fails closed", async () => {
  const proc = Bun.spawn(["bun", "hooks/goal-hook.mjs"], { env, stdin: "pipe", stdout: "pipe" });
  proc.stdin.write("not json at all"); proc.stdin.end();
  expect(await proc.exited).toBe(0);
});

test("PreToolUse drift warning after many tools without checkpoint", async () => {
  await runHook({ hook_event_name: "UserPromptSubmitted", session_id: "s1", cwd: "/w/p", prompt: "/goal x" });
  for (let i = 0; i < 6; i++) await runHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: "/w/p", tool_name: "read_file" });
  const { out } = await runHook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/w/p", tool_name: "read_file" });
  expect(JSON.parse(out).additionalContext).toMatch(/drift/i);
});

test("Stop with active goal blocks with continuation directive", async () => {
  await runHook({ hook_event_name: "UserPromptSubmitted", session_id: "s1", cwd: "/w/p", prompt: "/goal x" });
  const { out } = await runHook({ hook_event_name: "Stop", session_id: "s1", cwd: "/w/p" });
  expect(JSON.parse(out).decision).toBe("block");
});

test("subagentStart receives boundary only, never goal state", async () => {
  await runHook({ hook_event_name: "UserPromptSubmitted", session_id: "s1", cwd: "/w/p", prompt: "/goal x" });
  const { out } = await runHook({ hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/p" });
  const ctx = JSON.parse(out).additionalContext;
  expect(ctx).toContain("main-session only");
  expect(ctx).not.toContain("make tests green");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd goal-team && bun test tests/goal-hook.test.mjs`
Expected: FAIL — cannot find `hooks/goal-hook.mjs` (5 failures)

**Step 3: Write minimal implementation**

```js
// hooks/goal-hook.mjs — bun CLI hook: stdin JSON -> stdout JSON, always exit 0 (fail-open).
import { GoalStore } from "../lib/goal-store.mjs";
import os from "node:os";
import path from "node:path";

const DRIFT_LIMIT = 5;

function canonicalEvent(raw, body) {
  const v = String(raw || "").toLowerCase();
  if (v.includes("userprompt")) return "userPromptSubmitted";
  if (v.includes("sessionstart")) return "sessionStart";
  if (v.includes("precompact")) return "preCompact";
  if (v.includes("subagentstart")) return "subagentStart";
  if (v.includes("subagentstop")) return "subagentStop";
  if (v.includes("posttoolusefailure")) return "postToolUseFailure";
  if (v.includes("posttooluse")) return "postToolUse";
  if (v.includes("pretooluse")) return "preToolUse";
  if (v.includes("stop") || v.includes("agentstop")) return "agentStop";
  if (v.includes("notification")) return "notification";
  if (body.prompt !== undefined) return "userPromptSubmitted";
  return "sessionStart";
}

const ACTIVATION = /(^|[^\w/])\/goal\b|\b(new goal|goal mode|turn this into a goal|keep working until this is done|make sure everything is fixed|no escape|do it fully|deeply inspect and fix|verify and prove it|reach perfection|nothing left behind)\b/i;

async function main() {
  const raw = await Bun.stdin.text();
  let body = {};
  try { body = JSON.parse(raw); } catch { /* fail-open below */ }
  const event = canonicalEvent(body.hook_event_name ?? body.hookEventName, body);
  const sessionId = body.session_id ?? body.sessionId ?? "unknown-session";
  const cwd = body.cwd ?? body.workspace ?? process.cwd();

  const home = process.env.GOAL_TEAM_HOME || os.homedir();
  const store = new GoalStore({ stateRoot: path.join(home, ".goal-team", "state") });
  await store.init();

  const found = (await store.loadBySession(sessionId)) || (await store.loadByCwdSession(cwd, sessionId));
  // Only an "active" goal counts: a finished/abandoned record must never block a fresh start.
  const active = found && found.status === "active" ? found : null;
  const out = {};

  if (event === "subagentStart") {
    out.additionalContext = "Goal mode is main-session only. Do not use goalctl or goal state; return evidence to the main session.";
    console.log(JSON.stringify(out)); return;
  }

  if (event === "userPromptSubmitted" && !active) {
    const text = String(body.prompt ?? "");
    if (ACTIVATION.test(text)) {
      const objective = text.replace(ACTIVATION, "").trim() || "Goal mode task";
      const g = await store.open({ sessionId, cwd, objective });
      out.additionalContext = `Persisted draft goal created: ${g.id}\nObjective: ${objective}\nUse goalctl (status/checkpoint/finish) to drive it.`;
    }
    console.log(JSON.stringify(out)); return;
  }

  if (!active) {
    out.additionalContext = "goal-team ready. Start with /goal <objective>.";
    console.log(JSON.stringify(out)); return;
  }

  if (event === "postToolUse") {
    await store.bumpDrift(active.id); // real counter: tool calls since the last checkpoint
    console.log(JSON.stringify({})); return;
  }

  if (event === "preToolUse") {
    const drift = (await store.load(active.id)).drift || 0;
    if (drift > DRIFT_LIMIT) out.additionalContext = `Goal-state drift warning: ${drift} tool calls since the last checkpoint. Call goalctl checkpoint.`;
    console.log(JSON.stringify(out)); return;
  }

  if (event === "agentStop") {
    if (active.status === "active" && !(active.remaining || []).length) {
      out.decision = "block";
      out.reason = "STOP BLOCKED: active goal is still open. Call goalctl status, continue, then goalctl checkpoint/finish.";
      console.log(JSON.stringify(out)); return;
    }
    if (active.status === "active") {
      out.decision = "block";
      out.reason = `STOP BLOCKED: goal ${active.id} is open. Remaining: ${(active.remaining || []).join(" | ") || "none recorded"}`;
      console.log(JSON.stringify(out)); return;
    }
  }

  out.additionalContext = `Active goal ${active.id}: ${active.objective}\nStatus: ${active.status}`;
  console.log(JSON.stringify(out));
}

// Fail-open on every error: a broken hook must never block the agent.
main().catch(() => console.log(JSON.stringify({})));
```

```json
// goal-team/hooks.json — consumed by Copilot CLI; "bun" is the runtime on all platforms
// (bun.exe resolves on Windows PATH without the WSL/MSYS path-mangling traps).
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "userPromptSubmitted": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "preCompact": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "agentStop": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "subagentStart": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "subagentStop": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "preToolUse": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "postToolUse": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "timeoutSec": 5 }],
    "notification": [{ "type": "command", "bun": "hooks/goal-hook.mjs", "matcher": "agent_idle|agent_completed", "timeoutSec": 5 }]
  }
}
```

NOTE (Task 2 acceptance): if the host only accepts a `bash`/`command` field, fall back to `"command": "bun \"<ABS>/hooks/goal-hook.mjs\""` written by the installer with the resolved absolute path — never `$HOME` POSIX syntax, never bare `bash`.

**Step 4: Run tests to verify they pass**

Run: `cd goal-team && bun test tests/goal-hook.test.mjs`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add hooks/ hooks.json tests/goal-hook.test.mjs
git commit -m "feat: bun hook with fail-open context injection and drift/stop gates"
```

---

## Task 3: goalctl CLI (replaces goalSystem MCP entirely)

**Files:**
- Create: `goal-team/bin/goalctl.mjs`
- Test: `goal-team/tests/goalctl.test.mjs`

**Step 1: Write the failing tests**

```js
// tests/goalctl.test.mjs
import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import path from "node:path";

let home, env;
beforeEach(() => {
  home = tempHome("goal-team-ctl");
  env = { ...process.env, GOAL_TEAM_HOME: path.join(home, "state-home"), HOME: home, USERPROFILE: home };
});

async function ctl(...args) {
  const proc = Bun.spawn(["bun", "bin/goalctl.mjs", ...args], { cwd: import.meta.dir + "/..", env, stdout: "pipe", stderr: "pipe" });
  const out = await proc.stdout.text();
  return { code: await proc.exited, out: out.trim() };
}

test("open creates a goal and prints its id", async () => {
  const { code, out } = await ctl("open", "--session", "s1", "--cwd", "/w/p", "--objective", "ship it");
  expect(code).toBe(0);
  expect(JSON.parse(out).status).toBe("active");
});

test("status reports the active goal", async () => {
  await ctl("open", "--session", "s1", "--cwd", "/w/p", "--objective", "ship it");
  const { out } = await ctl("status", "--session", "s1");
  expect(JSON.parse(out).objective).toBe("ship it");
});

test("checkpoint replaces discoveredIssues (matches store semantics)", async () => {
  const { out: o1 } = await ctl("open", "--session", "s1", "--cwd", "/w/p", "--objective", "x");
  const id = JSON.parse(o1).id;
  await ctl("checkpoint", "--id", id, "--issue", "A");
  await ctl("checkpoint", "--id", id, "--issue", "B");
  const { out } = await ctl("status", "--session", "s1");
  expect(JSON.parse(out).discoveredIssues).toEqual(["B"]);
});

test("finish is refused while remaining work exists", async () => {
  const { out: o1 } = await ctl("open", "--session", "s1", "--cwd", "/w/p", "--objective", "x");
  const id = JSON.parse(o1).id;
  await ctl("checkpoint", "--id", id, "--next", "todo");
  const { code } = await ctl("finish", "--id", id, "--done", "d", "--evidence", "e", "--proof", "p", "--verify", "v", "--audit", "a");
  expect(code).not.toBe(0);
});

test("lesson appends to lessons.md", async () => {
  await ctl("lesson", "always test the failing path first");
  const proc = Bun.spawn(["cat", path.join(home, "state-home", ".goal-team", "state", "lessons.md")], { stdout: "pipe" });
  expect(await proc.stdout.text()).toContain("failing path");
});

test("doctor reports bun and store health", async () => {
  const { code, out } = await ctl("doctor");
  expect(code).toBe(0);
  expect(out).toContain("bun");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd goal-team && bun test tests/goalctl.test.mjs`
Expected: FAIL — `bin/goalctl.mjs` not found (6 failures)

**Step 3: Write minimal implementation**

```js
#!/usr/bin/env bun
// bin/goalctl.mjs — the ONLY mutation API for goal state (replaces the goalSystem MCP server).
import { GoalStore } from "../lib/goal-store.mjs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flags = (name) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}`) out.push(argv[i + 1]); return out; };

const home = process.env.GOAL_TEAM_HOME || os.homedir();
const store = new GoalStore({ stateRoot: path.join(home, ".goal-team", "state") });

function json(obj) { console.log(JSON.stringify(obj, null, 2)); }

await store.init();

switch (cmd) {
  case "open":
    json(await store.open({ sessionId: flag("session"), cwd: flag("cwd") || process.cwd(), objective: flag("objective") || "Goal mode task" }));
    break;
  case "status": {
    const g = flag("id") ? await store.load(flag("id"))
      : (await store.loadBySession(flag("session"))) || (await store.loadByCwdSession(flag("cwd") || process.cwd(), flag("session")));
    if (!g) { console.error("no goal found"); process.exit(1); }
    json(g); break;
  }
  case "checkpoint": {
    const patch = {};
    if (flags("done")) patch.doneSoFar = flags("done");
    if (flags("evidence")) patch.inspectionEvidence = flags("evidence");
    if (flags("verify")) patch.verificationResults = flags("verify");
    if (flags("issue")) patch.discoveredIssues = flags("issue");
    if (flags("next")) patch.remaining = flags("next");
    if (flags("blocker")) patch.blockers = flags("blocker");
    json(await store.checkpoint(flag("id"), patch)); break;
  }
  case "finish": {
    const patch = {
      doneSoFar: flags("done"), evidence: flags("evidence"), proof: flags("proof"),
      verify: flags("verify"), audit: flags("audit"), clearRemaining: argv.includes("--clear-remaining"),
    };
    json(await store.finish(flag("id"), patch)); break;
  }
  case "close":
    json(await store.close(flag("id"), { status: flag("status") || "cancelled" })); break;
  case "lesson":
    await store.lesson(argv.slice(1).join(" ")); console.log("lesson recorded"); break;
  case "doctor": {
    console.log(`bun ${Bun.version} ok`);
    console.log(`store ${store.root} ok`);
    break;
  }
  default:
    console.error("usage: goalctl open|status|checkpoint|finish|close|lesson|doctor [--id|--session|--cwd|--objective|--done|--evidence|--proof|--verify|--audit|--issue|--next|--blocker]");
    process.exit(2);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd goal-team && bun test tests/goalctl.test.mjs`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add bin/goalctl.mjs tests/goalctl.test.mjs
git commit -m "feat: goalctl CLI as the sole goal-state mutation API"
```

---

## Task 4: Skills + PRD + agents — the multi-agent loop (оценка → сбор данных → PRD → план → выполнение → ревью/фиксы → тесты → фиксы/апрув)

**Files:**
- Create: `goal-team/skills/goal-team/SKILL.md`
- Create: `goal-team/skills/goal-team/templates/prd.md`
- Create (core five): `goal-team/agents/goal-orchestrator.agent.md`, `goal-builder`, `goal-inspector`, `goal-researcher`, `goal-reviewer`
- Create (situational seven — роли по образцу gem-team растера `agent-team\.apm\agents`, контракты goal-team свои): `goal-debugger`, `goal-devops`, `goal-browser-tester`, `goal-mobile-tester`, `goal-documentation-writer`, `goal-code-simplifier`, `goal-skill-creator`
- Test: `goal-team/tests/agents.test.mjs`

**Step 1: Write the failing test** (frontmatter contract for every agent)

```js
// tests/agents.test.mjs
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

test("core and situational agents share the frontmatter contract", () => {
  const dir = import.meta.dir + "/../agents";
  const files = readdirSync(dir).filter((f) => f.endsWith(".agent.md"));
  const core = ["goal-orchestrator", "goal-builder", "goal-inspector", "goal-researcher", "goal-reviewer"];
  const situational = ["goal-debugger", "goal-devops", "goal-browser-tester", "goal-mobile-tester",
    "goal-documentation-writer", "goal-code-simplifier", "goal-skill-creator"];
  for (const name of [...core, ...situational]) {
    const text = readFileSync(`${dir}/${name}.agent.md`, "utf8");
    expect(text).toMatch(/^---\nname: goal-/);
    expect(text).toMatch(/mode: (primary|subagent)/);
    for (const section of ["<role>", "<rules>", "<output_format>"]) expect(text).toContain(section);
    expect(text).toContain("goalctl");
  }
  expect(files.length).toBe(core.length + situational.length);
});

test("skill declares the loop, PRD, multi-agent phases and backlog export", () => {
  const skill = readFileSync(import.meta.dir + "/../skills/goal-team/SKILL.md", "utf8");
  for (const phase of ["Оценка", "Сбор данных", "PRD", "План", "Выполнение", "Ревью/фиксы", "Тесты", "Фиксы/апрув"]) {
    expect(skill).toContain(phase);
  }
  expect(skill).toContain("2–4 parallel");
  expect(skill).toContain("backlog task create");
  const prd = readFileSync(import.meta.dir + "/../skills/goal-team/templates/prd.md", "utf8");
  expect(prd).toContain("Non-Goals");
  expect(prd).toContain("Success Metrics");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd goal-team && bun test tests/agents.test.mjs`
Expected: FAIL — agents dir empty / skill missing

**Step 3: Write the skill** (this is the loop the user specified)

```markdown
<!-- goal-team/skills/goal-team/SKILL.md -->
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
   inter-dependencies. **Backlog.md (optional):** if the `backlog` CLI is available,
   export each substage — `backlog task create "<N.M title>" -d "<AC, estimate, deps>" --ac "<criterion>"` —
   store the returned task id in plan.md and sync status with
   `backlog task edit <id> -s <status>` (statuses come from the backlog config). If the
   CLI is absent, skip with a note (graceful degradation). Dispatch `goal-reviewer`
   (mode: plan) to challenge the DAG before executing.
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
```

The PRD template (Task 4.1):

```markdown
<!-- goal-team/skills/goal-team/templates/prd.md -->
# PRD: <goal title>
> Генерируется автоматически: после grilling (если запрос был неясен) или прямо из запроса.
> Иммутабелен после фиксации (autonomy: full/standard — без блокирующего апрува, пользователь
> уведомлён и может наложить вето → новая ревизия; supervised — после апрува пользователя).
> Блокирующий апрув только для destructive/credentials/deploy.

## Problem
## Goals
## Non-Goals
## User Stories (INVEST + Acceptance Criteria)
## Constraints
## Risks
## Success Metrics
## Open Questions (из grilling)
```

**Step 4: Write the agents** (house style: `C:\Users\psyen\agent-team\.apm\agents\*.agent.md` — YAML frontmatter + `<role>` `<workflow>` `<output_format>` `<rules>`, ≤120 lines each; goal-team contracts are our own, adapted from gem-team's patterns "never review own work", "named specialist delegation", reviewer axes `standard|high|critic`)

Core five:

`goal-orchestrator.agent.md` (primary): owns the 8-phase loop, grilling + PRD gate, dispatches named specialists, wave scheduling (`max_concurrent: 3` builders; `2–4` in research/review phases by task size), cache-lifetime payload ordering (goal_id → prd → plan → task_id → context). Never implements.

`goal-builder.agent.md` (subagent): TDD red→green→refactor→verify, single commit per task (`feat/fix(scope): [B] ...`), returns `{status, files, tests_run, learn}`, never reviews own work. Also claims fix-wave findings by file partition.

`goal-inspector.agent.md` (subagent): fresh context, read-only verification + real test runs, writes verdict `{verdict: PASS|FAIL, findings[], evidence[]}`, never trusts builder/reviewer narrative (Inspector PASS ≠ human approval).

`goal-researcher.agent.md` (subagent): costed modes `scan|question|audit|trace|deep` (gem-team budget discipline), never upgrades own budget, writes `.goals/<id>/research/<agent>.md`, returns `{findings[], sources[], conflicts[], needs_revision}`.

`goal-reviewer.agent.md` (subagent): axes `review_mode standard|high|critic`, `review_target plan|task|code|decision|prd`, `review_scope changed|affected|full`, plus `focus correctness|tests|security|perf_arch` so 2–4 reviewers split the review surface in parallel; returns findings JSON; critic mode is read-only `{critic_verdict, challenges[], alternatives[]}`.

Situational seven (roles mirrored from gem-team's roster in `agent-team\.apm\agents\`, rewritten to the goal-team contract): `goal-debugger` (root-cause bugs/failing tests), `goal-devops` (deploy/CI/infra), `goal-browser-tester` (UI verification), `goal-mobile-tester` (mobile verification), `goal-documentation-writer` (docs/README/changelog), `goal-code-simplifier` (post-green behavior-preserving cleanup), `goal-skill-creator` (author/repair skills). The orchestrator dispatches one only when the task context matches.

(Each file: full YAML frontmatter with `name`, `description`, `mode`, `hidden`, `user-invocable`; body sections `<role>` `<workflow>` `<output_format>` with the exact JSON schema above, `<rules>` with the hard rules. Keep each ≤120 lines.)

**Step 5: Run tests to verify they pass**

Run: `cd goal-team && bun test tests/agents.test.mjs`
Expected: PASS (2 tests)

**Step 6: Commit**

```bash
git add skills/ agents/ tests/agents.test.mjs
git commit -m "feat: goal-team skill loop and five specialist agents"
```

---

## Task 5: Lessons + self-correction loop

**Files:**
- Modify: `goal-team/lib/goal-store.mjs` (lesson API already present — verify)
- Create: `goal-team/skills/goal-team/lessons.md` (seed)
- Test: `goal-team/tests/lessons.test.mjs`

**Step 1: Write the failing test**

```js
// tests/lessons.test.mjs
import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import { GoalStore } from "../lib/goal-store.mjs";
import path from "node:path";
import { readFileSync } from "node:fs";

let store, home;
beforeEach(async () => {
  home = tempHome("goal-team-lessons");
  store = new GoalStore({ stateRoot: path.join(home, "state") });
  await store.init();
});

test("lessons append chronologically", async () => {
  await store.lesson("first");
  await store.lesson("second");
  const text = readFileSync(path.join(home, "state", "lessons.md"), "utf8");
  expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
});
```

**Step 2: Run to verify it passes already** (implemented in Task 1) — if PASS, add the seed file and commit:

`skills/goal-team/lessons.md`: starter lessons verbatim from the 1.1.23 fixing session (bash=WSL trap, os.homedir()/USERPROFILE, POSIX modes, jq `\b`, MSYS argv mangling, CP1251 corruption) so every builder starts with them.

**Step 3: Commit**

```bash
git add skills/goal-team/lessons.md tests/lessons.test.mjs
git commit -m "feat: lesson capture with seed lessons from the 1.1.23 fixes"
```

---

## Task 6: Cross-platform installer + migration (kills the MCP entry and the extension)

**Files:**
- Create: `goal-team/scripts/install.mjs`
- Test: `goal-team/tests/install.test.mjs`

**Step 1: Write the failing tests** (Windows traps from 1.1.23 must be regression-tested)

```js
// tests/install.test.mjs
import { test, expect } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

test("install writes hooks.json with absolute bun paths and removes goalSystem MCP", async () => {
  const home = tempHome("goal-team-install");
  const copilot = path.join(home, ".copilot");
  const proc = Bun.spawn(["bun", "scripts/install.mjs"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot },
  });
  expect(await proc.exited).toBe(0);

  const hooks = JSON.parse(readFileSync(path.join(copilot, "settings.json"), "utf8"));
  const pre = hooks.hooks.preToolUse[0];
  // absolute path, no POSIX $HOME, no bare bash
  expect(pre.command ?? pre.bun).not.toContain("$HOME");
  expect(existsSync(path.join(copilot, "mcp-config.json")) && JSON.parse(readFileSync(path.join(copilot, "mcp-config.json"), "utf8")).mcpServers?.goalSystem === undefined).toBe(true);
});

test("install is idempotent and never marks files read-only", async () => {
  const home = tempHome("goal-team-install2");
  const copilot = path.join(home, ".copilot");
  const env = { ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot };
  expect(await Bun.spawn(["bun", "scripts/install.mjs"], { env }).exited).toBe(0);
  expect(await Bun.spawn(["bun", "scripts/install.mjs"], { env }).exited).toBe(0);
  const st = require("node:fs").statSync(path.join(copilot, "settings.json"));
  expect(st.mode & 0o200).toBeTruthy(); // writable bit survives on POSIX; on Windows mode is always 0o666
});
```

**Step 2: Run to verify they fail**

Run: `cd goal-team && bun test tests/install.test.mjs`
Expected: FAIL

**Step 3: Implementation** — `scripts/install.mjs` (bun): resolve `COPILOT_HOME` (`env.COPILOT_HOME` → `os.homedir()/.copilot`), copy `hooks/goal-hook.mjs` + `lib/`, write hook entries with **absolute bun command** (`bun "<abs>/hooks/goal-hook.mjs"`) — never `$HOME`, never `bash`; set modes numerically (`0o644`/`0o755` literals — POSIX constants are `undefined` on Windows); **remove `mcpServers.goalSystem`** from `mcp-config.json` if present (migration from copilot-goal-system); install `skills/goal-team` + `agents/`; idempotent (hash-compare before write). Full code mirrors `C:\Users\psyen\copilot-goal-system\scripts\install.mjs` (already Windows-fixed this session) minus the MCP/extension targets.

**Step 4: Run to verify they pass**

Run: `cd goal-team && bun test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add scripts/install.mjs tests/install.test.mjs
git commit -m "feat: cross-platform bun installer with MCP migration"
```

---

## Task 7: End-to-end verification + docs

**Steps:**
1. Run: `cd goal-team && bun test` → expect all green (count grows with US-1…US-5 coverage).
2. Run: `bun scripts/install.mjs` against a scratch `COPILOT_HOME`, then feed 5 synthetic hook payloads through `bun hooks/goal-hook.mjs` (SessionStart, UserPromptSubmitted with `/goal`, PostToolUse×6, PreToolUse, Stop) → expect exit 0 everywhere, `decision: "block"` on Stop.
3. Verify isolation: no writes outside `GOAL_TEAM_HOME` (snapshot hashes of real `~/.copilot` before/after, like the 1.1.23 fix session did).
4. Write `goal-team/README.md`: install, the 8-phase loop diagram (incl. grilling + auto-PRD), agent roles table (core 5 + situational 7), backlog.md planning integration (optional), config (`.goal-team.yaml` namespaced — avoids gem-team's top-level collision), migration notes from all 3 plugins + gem-team attribution.
5. Commit: `docs: README with loop, agents, migration from 3 plugins`.

---

## Decisions & Risks

- **MCP is gone by design:** everything `goalSystem` MCP exposed (status/open/checkpoint/finish/…) is `goalctl` subcommands; hooks inject context; skills carry the workflow. The VS Code extension is not needed — agents/skills/hooks are consumed directly by Copilot CLI and VS Code Chat (`chat.agentFilesLocations`, `chat.hookFilesLocations` already point at `~/.copilot`).
- **Bun, not bash/node:** single runtime for hook + CLI on all platforms; `bun.exe` avoids the WSL-bash path mangling; no jq dependency (bun does regex natively — removes the `\b`/MSYS classes of bug entirely).
- **`goal-team` namespace in `.goal-team.yaml`:** gem-team's `.gem-team.yaml` has hard-coded top-level keys; we use our own file with a `goal-team:` root key to avoid collisions if both are installed.
- **Parallelism caps:** ≤3 builders per execution wave (gem-team default is 2; user asked for "several subagents at once") and **2–4 parallel subagents in both the research and the review/fix phases** (S=2, M=3, L/XL=4 — the "2-3-4 depending on the task" rule); enforced in the orchestrator skill, not code — the harness only provides the DAG/task state.
- **PRD is the scope contract:** auto-generated after user grilling (≤5 questions per round) or straight from the request; immutable after user approval (gsemet pattern) — scope changes create a new revision.
- **Backlog.md planning integration is optional and CLI-level:** the skill shells out to `backlog task create "<N.M>" -d --ac` and `backlog task edit <id> -s` (flags verified against the local backlog CLI 2026-10-17); graceful skip when the CLI is absent — no library coupling, no crash.
- **Situational agents are adapted, not copied:** roles mirror gem-team's roster (debugger, devops, browser-tester, mobile-tester, documentation-writer, code-simplifier, skill-creator) rewritten to the goal-team JSON contract; keep attribution in README (source: `C:\Users\psyen\agent-team\.apm\agents\`).
- **Risk: Copilot CLI hook schema** (does it accept a `bun` field? vs `command`/`bash`/`windows`): Task 2's acceptance note covers the fallback; validate against `Docs\llms\github-copilot-llms.md` + live `~/.copilot/hooks/hooks.json` precedent (which already runs `bun unified-hook.mjs`) before finalizing.
- **Risk: backlog CLI status vocabulary** is configuration-dependent — the skill must discover allowed statuses (e.g. `backlog board`) instead of hard-coding "Review"; pinned flags only: `task create [title] -d --ac --dod -s -l`, `task edit <id> -s`.
- **Risk: bun missing on the target machine** — the installer checks `bun --version` first and exits 2 with install guidance; hooks stay inert (fail-open) until bun exists.
- **Risk: no subagent harness in the host** — the skill degrades to serial main-session execution (Autonomy → Degradation) and records the weakened independence as a caveat in `inspectionEvidence`.
- **Risk: subagent hang or malformed response** — dispatch contract: `timeout_sec` + one fresh retry, then lane switch + `discoveredIssues` entry; a wave never deadlocks on one task.
- **Risk: session interruption mid-loop** — durable store + `checkpoint --next` resume pointer; `goalctl status` resumes at the recorded phase (Resume contract).
- **Risk: second `/goal` in the same session** — `open` is idempotent per session and `finish`/`close` clear the indexes (regression-tested in Task 1) so a stale record can never block a new goal.