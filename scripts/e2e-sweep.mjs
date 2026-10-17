// scripts/e2e-sweep.mjs — Task 7 e2e: feeds synthetic hook payloads through hooks/goal-hook.mjs
// and checks the expected response for each lifecycle event. Exit 0 = all pass.
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const home = mkdtempSync(path.join(os.tmpdir(), "gt-e2e-"));
const env = { ...process.env, GOAL_TEAM_HOME: home, HOME: home, USERPROFILE: home };

async function send(payload) {
  const proc = Bun.spawn(["bun", "hooks/goal-hook.mjs"], {
    cwd: path.join(import.meta.dir, ".."), env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const out = (await proc.stdout.text()).trim();
  return { code: await proc.exited, out };
}

const base = { session_id: "e1", cwd: "C:\\w\\p" };
const steps = [
  ["1 SessionStart (no goal yet)", { ...base, hook_event_name: "SessionStart" },
    (o) => o.includes("goal-team ready")],
  ["2 UserPromptSubmitted /goal creates draft", { ...base, hook_event_name: "UserPromptSubmitted", prompt: "/goal e2e sweep" },
    (o) => o.includes("draft goal")],
  ...Array.from({ length: 6 }, (_, i) => [`3.${i + 1} PostToolUse bumps drift`, { ...base, hook_event_name: "PostToolUse", tool_name: "read_file" },
    (o) => o === "{}"]),
  ["9 PreToolUse warns about drift", { ...base, hook_event_name: "PreToolUse", tool_name: "read_file" },
    (o) => /drift/i.test(o)],
  ["10 Stop blocks with continuation", { ...base, hook_event_name: "Stop" },
    (o) => JSON.parse(o).decision === "block"],
];

let failed = 0;
for (const [name, payload, ok] of steps) {
  const { code, out } = await send(payload);
  const pass = code === 0 && ok(out);
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} | exit=${code} | ${out}`);
}
console.log(failed ? `E2E FAILED: ${steps.length - failed}/${steps.length}` : `E2E OK: ${steps.length}/${steps.length}`);
process.exit(failed ? 1 : 0);
