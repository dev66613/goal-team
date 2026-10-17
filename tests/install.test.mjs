import { test, expect } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import path from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";

async function runInstall(env) {
  const proc = Bun.spawn(["bun", "scripts/install.mjs"], {
    cwd: path.join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
  });
  await proc.stdout.text();
  return await proc.exited;
}

test("install writes hooks.json with absolute bun paths and removes goalSystem MCP", async () => {
  const home = tempHome("goal-team-install");
  const copilot = path.join(home, ".copilot");
  const code = await runInstall({ ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot });
  expect(code).toBe(0);

  const settings = JSON.parse(readFileSync(path.join(copilot, "settings.json"), "utf8"));
  const pre = settings.hooks.hooks.preToolUse[0];
  // absolute path, no POSIX $HOME, no bare bash
  expect(pre.command ?? pre.bun).not.toContain("$HOME");
  expect(pre.command ?? pre.bun).not.toMatch(/^bash\b/);
  expect(pre.command ?? pre.bun).toContain("goal-hook.mjs");

  expect(existsSync(path.join(copilot, "mcp-config.json"))).toBe(true);
  const mcp = JSON.parse(readFileSync(path.join(copilot, "mcp-config.json"), "utf8"));
  expect(mcp.mcpServers?.goalSystem).toBe(undefined);
});

test("install is idempotent and never marks files read-only", async () => {
  const home = tempHome("goal-team-install2");
  const copilot = path.join(home, ".copilot");
  const env = { ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot };
  expect(await runInstall(env)).toBe(0);
  expect(await runInstall(env)).toBe(0);
  const st = statSync(path.join(copilot, "settings.json"));
  expect(st.mode & 0o200).toBeTruthy(); // writable bit survives on POSIX; on Windows mode is always 0o666
  expect(existsSync(path.join(copilot, "goal-team", "hooks", "goal-hook.mjs"))).toBe(true);
  expect(existsSync(path.join(copilot, "goal-team", "skills", "goal-team", "SKILL.md"))).toBe(true);
});
