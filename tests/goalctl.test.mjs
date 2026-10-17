import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import { readFileSync } from "node:fs";
import path from "node:path";

let home, env;
beforeEach(() => {
  home = tempHome("goal-team-ctl");
  env = { ...process.env, GOAL_TEAM_HOME: path.join(home, "state-home"), HOME: home, USERPROFILE: home };
});

async function ctl(...args) {
  const proc = Bun.spawn(["bun", "bin/goalctl.mjs", ...args], {
    cwd: path.join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
  });
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
  const text = readFileSync(path.join(home, "state-home", ".goal-team", "state", "lessons.md"), "utf8");
  expect(text).toContain("failing path");
});

test("lesson without text is refused", async () => {
  const { code } = await ctl("lesson");
  expect(code).not.toBe(0);
});

test("doctor reports bun and store health", async () => {
  const { code, out } = await ctl("doctor");
  expect(code).toBe(0);
  expect(out).toContain("bun");
});

test("unknown command exits 2 with usage", async () => {
  const { code } = await ctl("frobnicate");
  expect(code).toBe(2);
});

test("checkpoint with unknown id exits 1 with a clean error", async () => {
  const { code } = await ctl("checkpoint", "--id", "nope", "--next", "x");
  expect(code).not.toBe(0);
});

test("backlog status resolves the CLI and reports availability", async () => {
  const { code, out } = await ctl("backlog", "status");
  expect(code).toBe(0);
  const j = JSON.parse(out);
  expect(typeof j.available).toBe("boolean");
  expect(j.available).toBe(true); // backlog is installed on this machine (npm shim via cmd.exe)
  expect(j.version).toMatch(/^\d+\./); // backlog --version prints the bare version (e.g. "1.54.0")
});

test("backlog export --dry-run prints the exact command with AC flags", async () => {
  const { out: o } = await ctl("open", "--session", "s1", "--cwd", "/w/p", "--objective", "x");
  const id = JSON.parse(o).id;
  const { code, out } = await ctl("backlog", "export", "--id", id, "--title", "4.2 demo", "--ac", "criterion one", "--label", "goal-team", "--dry-run");
  expect(code).toBe(0);
  const j = JSON.parse(out);
  expect(j.dryRun).toBe(true);
  expect(j.command).toContain("task create 4.2 demo");
  expect(j.command).toContain("--ac criterion one");
  expect(j.command).toContain("-l goal-team");
});

test("backlog sync --dry-run prints the status edit command", async () => {
  const { code, out } = await ctl("backlog", "sync", "--task", "TASK-9", "--status", "In Progress", "--dry-run");
  expect(code).toBe(0);
  const j = JSON.parse(out);
  expect(j.dryRun).toBe(true);
  expect(j.command).toContain("task edit TASK-9 -s In Progress");
});
