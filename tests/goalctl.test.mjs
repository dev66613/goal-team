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

test("doctor reports bun and store health", async () => {
  const { code, out } = await ctl("doctor");
  expect(code).toBe(0);
  expect(out).toContain("bun");
});
