#!/usr/bin/env bun
// scripts/install.mjs — cross-platform installer for goal-team.
// Installs the runtime tree into <COPILOT_HOME>/goal-team/, registers hook entries with
// absolute paths (never $HOME, never bare bash), and migrates away the goalSystem MCP entry.
import { mkdir, readFile, writeFile, copyFile, readdir, chmod } from "node:fs/promises";
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

function hookEntry() {
  return { type: "command", command: `bun "${hookPath}"`, bun: hookPath, timeoutSec: 5 };
}

async function main() {
  console.log(`goal-team install: bun ${Bun.version}, copilot home ${copilotHome}`);

  // 1. Runtime tree (hooks, lib, bin, skills, agents, hooks.json).
  for (const dir of ["lib", "hooks", "bin", "skills", "agents"]) {
    await copyTree(path.join(repoRoot, dir), path.join(installRoot, dir));
  }
  await copyReplacing(path.join(repoRoot, "hooks.json"), path.join(installRoot, "hooks.json"));
  await chmod(path.join(installRoot, "bin", "goalctl.mjs"), EXECUTABLE_MODE).catch(() => {});
  await chmod(hookPath, EXECUTABLE_MODE).catch(() => {});

  // 2. Hook registration in settings.json: embed the hooks doc under "hooks",
  //    keeping any pre-existing user entries that are not ours.
  const settingsPath = path.join(copilotHome, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
  const embedded = settings.hooks?.hooks ? settings.hooks : { version: 1, hooks: {} };
  const entry = hookEntry();
  for (const ev of HOOK_EVENTS) {
    const keep = (embedded.hooks[ev] || []).filter(
      (h) => !String(h.command ?? h.bun ?? "").includes("goal-hook.mjs"),
    );
    embedded.hooks[ev] = [...keep, ev === "notification" ? { ...entry, matcher: "agent_idle|agent_completed" } : entry];
  }
  settings.hooks = embedded;
  await writeIfChanged(settingsPath, JSON.stringify(settings, null, 2));

  // 3. Migration: drop the goalSystem MCP server (copilot-goal-system → goal-team).
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
