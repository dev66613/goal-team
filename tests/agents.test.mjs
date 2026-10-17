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
    expect(text).toMatch(/^---\r?\nname: goal-/);
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
