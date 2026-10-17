// hooks/goal-hook.mjs — bun CLI hook: stdin JSON -> stdout JSON, always exit 0 (fail-open).
import { GoalStore } from "../lib/goal-store.mjs";
import os from "node:os";
import path from "node:path";

const DRIFT_LIMIT = 5;

function canonicalEvent(raw, body) {
  const v = String(raw || "").toLowerCase();
  if (v.includes("userprompt")) return "userPromptSubmitted";
  if (v.includes("sessionstart")) return "sessionStart";
  if (v.includes("precompact")) return "preCompact";
  if (v.includes("subagentstart")) return "subagentStart";
  if (v.includes("subagentstop")) return "subagentStop";
  if (v.includes("posttoolusefailure")) return "postToolUseFailure";
  if (v.includes("posttooluse")) return "postToolUse";
  if (v.includes("pretooluse")) return "preToolUse";
  if (v.includes("stop") || v.includes("agentstop")) return "agentStop";
  if (v.includes("notification")) return "notification";
  if (body.prompt !== undefined) return "userPromptSubmitted";
  return "sessionStart";
}

const ACTIVATION = /(^|[^\w/])\/goal\b|\b(new goal|goal mode|turn this into a goal|keep working until this is done|make sure everything is fixed|no escape|do it fully|deeply inspect and fix|verify and prove it|reach perfection|nothing left behind)\b/i;

async function main() {
  const raw = await Bun.stdin.text();
  let body = {};
  try { body = JSON.parse(raw); } catch { /* fail-open below */ }
  const event = canonicalEvent(body.hook_event_name ?? body.hookEventName, body);
  const sessionId = body.session_id ?? body.sessionId ?? "unknown-session";
  const cwd = body.cwd ?? body.workspace ?? process.cwd();

  const home = process.env.GOAL_TEAM_HOME || os.homedir();
  const store = new GoalStore({ stateRoot: path.join(home, ".goal-team", "state") });
  await store.init();

  const found = (await store.loadBySession(sessionId)) || (await store.loadByCwdSession(cwd, sessionId));
  // Only an "active" goal counts: a finished/abandoned record must never block a fresh start.
  const active = found && found.status === "active" ? found : null;
  const out = {};

  if (event === "subagentStart") {
    out.additionalContext = "Goal mode is main-session only. Do not use goalctl or goal state; return evidence to the main session.";
    console.log(JSON.stringify(out)); return;
  }

  if (event === "userPromptSubmitted" && !active) {
    const text = String(body.prompt ?? "");
    if (ACTIVATION.test(text)) {
      const objective = text.replace(ACTIVATION, "").trim() || "Goal mode task";
      const g = await store.open({ sessionId, cwd, objective });
      out.additionalContext = `Persisted draft goal created: ${g.id}\nObjective: ${objective}\nUse goalctl (status/checkpoint/finish) to drive it.`;
    }
    console.log(JSON.stringify(out)); return;
  }

  if (!active) {
    out.additionalContext = "goal-team ready. Start with /goal <objective>.";
    console.log(JSON.stringify(out)); return;
  }

  if (event === "postToolUse") {
    await store.bumpDrift(active.id); // real counter: tool calls since the last checkpoint
    console.log(JSON.stringify({})); return;
  }

  if (event === "preToolUse") {
    const drift = (await store.load(active.id)).drift || 0;
    if (drift > DRIFT_LIMIT) out.additionalContext = `Goal-state drift warning: ${drift} tool calls since the last checkpoint. Call goalctl checkpoint.`;
    console.log(JSON.stringify(out)); return;
  }

  if (event === "agentStop") {
    const remaining = active.remaining || [];
    out.decision = "block";
    out.reason = remaining.length
      ? `STOP BLOCKED: goal ${active.id} is open. Remaining: ${remaining.join(" | ")}`
      : `STOP BLOCKED: active goal ${active.id} is still open. Call goalctl status, continue, then goalctl checkpoint/finish.`;
    console.log(JSON.stringify(out)); return;
  }

  out.additionalContext = `Active goal ${active.id}: ${active.objective}\nStatus: ${active.status}`;
  console.log(JSON.stringify(out));
}

// Fail-open on every error: a broken hook must never block the agent.
// Top-level await keeps the module alive until stdin is fully processed —
// a bare `main()` call lets bun exit before the read resolves on Windows.
await main().catch(() => console.log(JSON.stringify({})));
