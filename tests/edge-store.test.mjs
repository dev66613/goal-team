import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import { GoalStore } from "../lib/goal-store.mjs";
import path from "node:path";

let store, home;
beforeEach(async () => {
  home = tempHome("goal-team-edge");
  store = new GoalStore({ stateRoot: path.join(home, "state") });
  await store.init();
});

test("concurrent opens in one session converge on one goal", async () => {
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    store.open({ sessionId: "s1", cwd: "/w/p", objective: `try ${i}` })));
  expect(new Set(results.map((g) => g.id)).size).toBe(1);
});

test("a new goal can start after close (fresh state)", async () => {
  const a = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "one" });
  await store.close(a.id, { status: "cancelled" });
  const b = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "two" });
  expect(b.id).not.toBe(a.id);
  expect(b.objective).toBe("two");
});

test("distinct session ids never share a state file (sanitize collisions)", async () => {
  const a = await store.open({ sessionId: "a/b", cwd: "/w/p", objective: "first" });
  const b = await store.open({ sessionId: "a_b", cwd: "/w/p", objective: "second" });
  expect(b.id).not.toBe(a.id);
  expect((await store.loadBySession("a/b")).objective).toBe("first");
  expect((await store.loadBySession("a_b")).objective).toBe("second");
});

test("finish with clearRemaining succeeds and clears indexes", async () => {
  const g = await store.open({ sessionId: "s1", cwd: "/w/p", objective: "x" });
  await store.checkpoint(g.id, { remaining: ["leftover"] });
  const done = await store.finish(g.id, {
    doneSoFar: ["d"], evidence: ["e"], proof: ["p"], verify: ["v"], audit: ["a"], clearRemaining: true,
  });
  expect(done.status).toBe("complete");
  expect(await store.loadBySession("s1")).toBe(null);
});
