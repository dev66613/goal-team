import { test, expect, beforeEach } from "bun:test";
import { tempHome } from "./helpers/env.cjs";
import { GoalStore } from "../lib/goal-store.mjs";
import path from "node:path";
import { readFileSync } from "node:fs";

let store, home;
beforeEach(async () => {
  home = tempHome("goal-team-lessons");
  store = new GoalStore({ stateRoot: path.join(home, "state") });
  await store.init();
});

test("lessons append chronologically", async () => {
  await store.lesson("first");
  await store.lesson("second");
  const text = readFileSync(path.join(home, "state", "lessons.md"), "utf8");
  expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
});
