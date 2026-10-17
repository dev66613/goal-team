#!/usr/bin/env bun
// scripts/install.mjs — cross-platform installer for goal-team.
// Installs the runtime tree into <COPILOT_HOME>/goal-team/, installs skills into
// <COPILOT_HOME>/skills/ (the verified user-scope skill location), registers hooks as
// <COPILOT_HOME>/hooks/goal-team.json in the verified Copilot hook-file format
// (command + bash + powershell, absolute paths — never $HOME, never bare bash), and
// migrates away copilot-goal-system wiring (MCP entry, legacy hook files, inline hooks).
import { mkdir, readFile, writeFile, copyFile, readdir, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EXECUTABLE_MODE = 0o755; // numeric literals: POSIX constants are undefined on Windows
const WRITABLE_MODE = 0o644;

const repoRoot = path.join(import.meta.dir, "..");
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const installRoot = path.join(copilotHome, "goal-team");
const hookPath = path.join(installRoot, "hooks", "goal-hook.mjs");

const HOOK_EVENTS = [
  "sessionStart", "userPromptSubmitted", "preCompact", "agentStop",
  "subagentStart", "subagentStop", "preToolUse", "postToolUse", "notification",
];

async function copyReplacing(src, dst) {
  await mkdir(path.dirname(dst), { recursive: true });
  try { await chmod(dst, WRITABLE_MODE); } catch { /* not there yet or not chmod-able */ }
  await copyFile(src, dst);
  await chmod(dst, WRITABLE_MODE).catch(() => {});
}

async function copyTree(src, dst) {
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else await copyReplacing(s, d);
  }
}

async function writeIfChanged(file, content) {
  if (existsSync(file)) {
    const current = await readFile(file, "utf8");
    if (current === content) {
      await chmod(file, WRITABLE_MODE).catch(() => {});
      return false;
    }
    try { await chmod(file, WRITABLE_MODE); } catch { /* ignore */ }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, WRITABLE_MODE).catch(() => {});
  return true;
}

// Verified hook-entry vocabulary (GitHub Copilot hooks reference + VS Code Local
// "Copilot format" mapping, cross-checked 2026-10-17): command + bash + powershell
// + timeoutSec + matcher. No unverified fields — file-loaded items are dropped when
// malformed, so schema drift would silently kill the hook.
const bunExe = Bun.which("bun") || "bun";
function hookEntry(extra = {}) {
  const cmd = `bun "${hookPath}"`;
  return {
    type: "command",
    command: cmd,
    bash: cmd,
    powershell: `& "${bunExe}" "${hookPath}"`, // 0350: the host's Windows shell is PowerShell
    timeoutSec: 8,
    ...extra,
  };
}
function hookFileDoc() {
  return {
    version: 1,
    hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => [
      ev,
      [ev === "notification" ? hookEntry({ matcher: "agent_idle|agent_completed" }) : hookEntry()],
    ])),
  };
}
const GOAL_HOOK_RE = /goal-context\.sh|goal-system|goal-hook\.mjs/;

async function main() {
  console.log(`goal-team install: bun ${Bun.version}, copilot home ${copilotHome}`);

  // 1. Runtime tree (hooks, lib, bin, skills, agents, hooks.json).
  for (const dir of ["lib", "hooks", "bin", "skills", "agents"]) {
    await copyTree(path.join(repoRoot, dir), path.join(installRoot, dir));
  }
  await copyReplacing(path.join(repoRoot, "hooks.json"), path.join(installRoot, "hooks.json"));
  await chmod(path.join(installRoot, "bin", "goalctl.mjs"), EXECUTABLE_MODE).catch(() => {});
  await chmod(hookPath, EXECUTABLE_MODE).catch(() => {});

  // 2. Hook registration as a user-scope hook FILE: discovered by BOTH Copilot CLI
  //    and the VS Code (and Insiders) Copilot harness. Never inline in settings.json —
  //    inline hooks are schema-strict there and would reject the whole field.
  await mkdir(path.join(copilotHome, "hooks"), { recursive: true });
  await writeIfChanged(path.join(copilotHome, "hooks", "goal-team.json"), JSON.stringify(hookFileDoc(), null, 2));

  // 2b. Skills into <COPILOT_HOME>/skills/ (built-in user skill location for VS Code,
  //     Insiders and Copilot CLI; chat.agentSkillsLocations is deprecated/ignored).
  for (const skill of ["goal-team", "backlog-md"]) {
    await copyTree(path.join(repoRoot, "skills", skill), path.join(copilotHome, "skills", skill));
  }

  // 3. Migration away from copilot-goal-system (and our own pre-1.0 inline shape).
  //    Inline hook cleanup keeps any non-goal entries the user owns.
  const settingsPath = path.join(copilotHome, "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    if (settings.hooks?.hooks) {
      delete settings.hooks; // our old wrong-shape embed — registration is file-based now
      await writeIfChanged(settingsPath, JSON.stringify(settings, null, 2));
      console.log("migration: dropped legacy inline goal-team hooks from settings.json");
    } else if (settings.hooks) {
      let removed = 0;
      for (const ev of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[ev])) continue;
        const keep = settings.hooks[ev].filter((h) => !GOAL_HOOK_RE.test(JSON.stringify(h)));
        removed += settings.hooks[ev].length - keep.length;
        if (keep.length) settings.hooks[ev] = keep; else delete settings.hooks[ev];
      }
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      if (removed) {
        await writeIfChanged(settingsPath, JSON.stringify(settings, null, 2));
        console.log(`migration: removed ${removed} legacy goal hook entries from settings.json`);
      }
    }
  }

  // 3b. Legacy goal-system artifacts in the hooks dir (incl. stale .backup-* files).
  for (const f of await readdir(path.join(copilotHome, "hooks")).catch(() => [])) {
    if (f === "goal-context.sh" || f.startsWith("goal-system-vscode.json")) {
      await rm(path.join(copilotHome, "hooks", f), { force: true });
      console.log(`migration: removed ${f}`);
    }
  }
  await rm(path.join(copilotHome, "extensions", "goal-system"), { recursive: true, force: true });

  // 3c. Identity-checked legacy skill: only remove skills/goal when its SKILL.md proves
  //     it is copilot-goal-system's (never delete a user's own "goal" skill blind).
  const legacySkill = path.join(copilotHome, "skills", "goal", "SKILL.md");
  if (existsSync(legacySkill) && (await readFile(legacySkill, "utf8")).includes("Main-session goal-mode execution")) {
    await rm(path.join(copilotHome, "skills", "goal"), { recursive: true, force: true });
    console.log("migration: removed legacy goal skill (verified copilot-goal-system)");
  }

  // 3d. Drop the goalSystem MCP server.
  const mcpPath = path.join(copilotHome, "mcp-config.json");
  const mcp = existsSync(mcpPath) ? JSON.parse(await readFile(mcpPath, "utf8")) : {};
  if (mcp.mcpServers?.goalSystem) {
    delete mcp.mcpServers.goalSystem;
    console.log("migration: removed mcpServers.goalSystem");
  }
  if (!mcp.mcpServers) mcp.mcpServers = {};
  await writeIfChanged(mcpPath, JSON.stringify(mcp, null, 2));

  console.log(`done. runtime: ${installRoot}`);
}

await main();
