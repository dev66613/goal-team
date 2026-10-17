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
    cwd: path.join(import.meta.dir, ".."),
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

test("empty stdin exits 0 (fail-open)", async () => {
  const proc = Bun.spawn(["bun", "hooks/goal-hook.mjs"], { env, stdin: "pipe", stdout: "pipe" });
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
});

test("unknown event with an active goal returns context without crashing", async () => {
  await runHook({ hook_event_name: "UserPromptSubmitted", session_id: "s1", cwd: "/w/p", prompt: "/goal x" });
  const { code, out } = await runHook({ hook_event_name: "SomethingNew", session_id: "s1", cwd: "/w/p" });
  expect(code).toBe(0);
  expect(JSON.parse(out).additionalContext).toContain("Active goal");
});
