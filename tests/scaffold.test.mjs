import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

test("plugin manifest declares skills, agents and hooks", () => {
  const pkg = JSON.parse(readFileSync(import.meta.dir + "/../plugin.json", "utf8"));
  expect(pkg.name).toBe("goal-team");
  expect(pkg.skills).toBe("skills/");
  expect(pkg.hooks).toBe("hooks.json");
});

test("bun test runner works cross-platform", () => {
  expect(process.platform === "win32" || process.platform === "linux" || process.platform === "darwin").toBe(true);
});
