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
