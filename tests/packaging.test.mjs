import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const PLUGIN_ROOT_TOKEN = /\$\{(PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|COPILOT_PLUGIN_ROOT)\}/;

test("plugin hook commands never use cwd-relative script paths (PLUGIN_ROOT only)", () => {
  const doc = JSON.parse(readFileSync(import.meta.dir + "/../hooks.json", "utf8"));
  for (const [event, entries] of Object.entries(doc.hooks)) {
    for (const entry of entries) {
      for (const field of ["command", "bash", "powershell"]) {
        const value = entry[field];
        if (!value) continue;
        // A bare "hooks/..." path resolves against the host's cwd, not the plugin root:
        // that produced "Cannot find module 'hooks/goal-hook.mjs'" in a live session.
        expect(`${event}.${field}: ${value}`).toMatch(PLUGIN_ROOT_TOKEN);
        expect(value).not.toMatch(/bun\s+"hooks\//);
      }
    }
  }
});

test("marketplace index lists this plugin with a resolvable source", () => {
  const market = JSON.parse(readFileSync(import.meta.dir + "/../.github/plugin/marketplace.json", "utf8"));
  const plugin = JSON.parse(readFileSync(import.meta.dir + "/../plugin.json", "utf8"));
  expect(market.name).toBeTruthy();
  expect(market.owner?.name).toBeTruthy();
  const entry = market.plugins.find((p) => p.name === plugin.name);
  expect(entry).toBeTruthy(); // entry name must match the manifest name or installs fail
  expect(entry.source).toBe(".");
  expect(entry.version).toBe(plugin.version);
});
