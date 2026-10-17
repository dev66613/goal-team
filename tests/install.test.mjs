import { test, expect } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import path from "node:path";
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";

async function runInstall(env) {
  const proc = Bun.spawn(["bun", "scripts/install.mjs"], {
    cwd: path.join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
  });
  await proc.stdout.text();
  return await proc.exited;
}

test("install writes the hook file in verified schema and removes goalSystem wiring", async () => {
  const home = tempHome("goal-team-install");
  const copilot = path.join(home, ".copilot");
  // seed legacy copilot-goal-system artifacts to prove migration removes them
  mkdirSync(path.join(copilot, "hooks"), { recursive: true });
  writeFileSync(path.join(copilot, "hooks", "goal-context.sh"), "#!/bin/bash\n");
  writeFileSync(path.join(copilot, "hooks", "goal-system-vscode.json"), "{}");
  mkdirSync(path.join(copilot, "skills", "goal"), { recursive: true });
  writeFileSync(path.join(copilot, "skills", "goal", "SKILL.md"), "---\nname: goal\n---\nMain-session goal-mode execution for Copilot.\n");
  writeFileSync(path.join(copilot, "settings.json"), JSON.stringify({
    keepMe: true,
    hooks: { sessionStart: [{ type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 }] },
  }));
  writeFileSync(path.join(copilot, "mcp-config.json"), JSON.stringify({
    mcpServers: { goalSystem: { type: "local" }, keepServer: { type: "local" } },
  }));
  expect(await runInstall({ ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot })).toBe(0);

  const hookFile = JSON.parse(readFileSync(path.join(copilot, "hooks", "goal-team.json"), "utf8"));
  expect(hookFile.version).toBe(1);
  const entry = hookFile.hooks.preToolUse[0];
  // verified vocabulary with absolute paths: no POSIX $HOME anywhere
  expect(JSON.stringify(hookFile)).not.toContain("$HOME");
  expect(entry.command).toContain("goal-hook.mjs");
  expect(entry.bash).toContain("goal-hook.mjs");
  expect(entry.powershell).toContain("goal-hook.mjs");
  expect(hookFile.hooks.notification[0].matcher).toBe("agent_idle|agent_completed");

  // migration: legacy wiring gone, user data intact
  expect(existsSync(path.join(copilot, "hooks", "goal-context.sh"))).toBe(false);
  expect(existsSync(path.join(copilot, "hooks", "goal-system-vscode.json"))).toBe(false);
  expect(existsSync(path.join(copilot, "skills", "goal"))).toBe(false);
  const settings = JSON.parse(readFileSync(path.join(copilot, "settings.json"), "utf8"));
  expect(settings.keepMe).toBe(true);
  expect(settings.hooks).toBe(undefined);
  const mcp = JSON.parse(readFileSync(path.join(copilot, "mcp-config.json"), "utf8"));
  expect(mcp.mcpServers.goalSystem).toBe(undefined);
  expect(mcp.mcpServers.keepServer).toBeTruthy();
});

test("install is idempotent, installs skills, and never marks files read-only", async () => {
  const home = tempHome("goal-team-install2");
  const copilot = path.join(home, ".copilot");
  const env = { ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot };
  expect(await runInstall(env)).toBe(0);
  expect(await runInstall(env)).toBe(0);
  const st = statSync(path.join(copilot, "hooks", "goal-team.json"));
  expect(st.mode & 0o200).toBeTruthy(); // writable bit survives on POSIX; on Windows mode is always 0o666
  expect(existsSync(path.join(copilot, "goal-team", "hooks", "goal-hook.mjs"))).toBe(true);
  expect(existsSync(path.join(copilot, "skills", "goal-team", "SKILL.md"))).toBe(true);
  expect(existsSync(path.join(copilot, "skills", "backlog-md", "SKILL.md"))).toBe(true);
});

test("install keeps user-owned hook entries and settings keys", async () => {
  const home = tempHome("goal-team-install3");
  const copilot = path.join(home, ".copilot");
  mkdirSync(copilot, { recursive: true });
  writeFileSync(path.join(copilot, "settings.json"), JSON.stringify({
    someSetting: true,
    hooks: {
      preToolUse: [
        { type: "command", command: "user-tool", timeoutSec: 3 },
        { type: "command", bash: "$HOME/.copilot/hooks/goal-context.sh", timeoutSec: 5 },
      ],
    },
  }));
  const env = { ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home, COPILOT_HOME: copilot };
  expect(await runInstall(env)).toBe(0);
  const s = JSON.parse(readFileSync(path.join(copilot, "settings.json"), "utf8"));
  expect(s.someSetting).toBe(true);
  expect(s.hooks.preToolUse.length).toBe(1);
  expect(s.hooks.preToolUse[0].command).toBe("user-tool");
  // nothing goal-related is registered inline anymore
  expect(JSON.stringify(s.hooks)).not.toContain("goal");
});
