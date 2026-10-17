#!/usr/bin/env bun
// bin/goalctl.mjs — the ONLY mutation API for goal state (replaces the goalSystem MCP server).
import { GoalStore } from "../lib/goal-store.mjs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flags = (name) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}`) out.push(argv[i + 1]); return out; };

const home = process.env.GOAL_TEAM_HOME || os.homedir();
const store = new GoalStore({ stateRoot: path.join(home, ".goal-team", "state") });

function json(obj) { console.log(JSON.stringify(obj, null, 2)); }

await store.init();

try {
  switch (cmd) {
    case "open":
      json(await store.open({ sessionId: flag("session"), cwd: flag("cwd") || process.cwd(), objective: flag("objective") || "Goal mode task" }));
      break;
    case "status": {
      const g = flag("id") ? await store.load(flag("id"))
        : (await store.loadBySession(flag("session"))) || (await store.loadByCwdSession(flag("cwd") || process.cwd(), flag("session")));
      if (!g) { console.error("no goal found"); process.exit(1); }
      json(g); break;
    }
    case "checkpoint": {
      const patch = {};
      if (flags("done").length) patch.doneSoFar = flags("done");
      if (flags("evidence").length) patch.inspectionEvidence = flags("evidence");
      if (flags("verify").length) patch.verificationResults = flags("verify");
      if (flags("issue").length) patch.discoveredIssues = flags("issue");
      if (flags("next").length) patch.remaining = flags("next");
      if (flags("blocker").length) patch.blockers = flags("blocker");
      json(await store.checkpoint(flag("id"), patch)); break;
    }
    case "finish": {
      const patch = {
        doneSoFar: flags("done"), evidence: flags("evidence"), proof: flags("proof"),
        verify: flags("verify"), audit: flags("audit"), clearRemaining: argv.includes("--clear-remaining"),
      };
      json(await store.finish(flag("id"), patch)); break;
    }
    case "close":
      json(await store.close(flag("id"), { status: flag("status") || "cancelled" })); break;
    case "lesson": {
      const text = argv.slice(1).join(" ").trim();
      if (!text) { console.error("[goalctl] Failed to record lesson: empty text"); process.exit(2); }
      await store.lesson(text); console.log("lesson recorded"); break;
    }
    case "doctor": {
      console.log(`bun ${Bun.version} ok`);
      console.log(`store ${store.root} ok`);
      break;
    }
    default:
      console.error("usage: goalctl open|status|checkpoint|finish|close|lesson|doctor [--id|--session|--cwd|--objective|--done|--evidence|--proof|--verify|--audit|--issue|--next|--blocker]");
      process.exit(2);
  }
} catch (e) {
  console.error(`[goalctl] Failed to ${cmd || "run"}: ${e.message}`);
  process.exit(1);
}
