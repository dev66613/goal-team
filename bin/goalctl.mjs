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

// The backlog CLI ships as an npm shim: on Windows that is backlog.cmd/.ps1, which
// CreateProcess cannot run directly — go through cmd.exe /c (verified 2026-10-17).
function backlogInvocation(args) {
  if (process.env.GOAL_TEAM_BACKLOG_BIN) return [process.env.GOAL_TEAM_BACKLOG_BIN, ...args];
  if (process.platform === "win32") return [process.env.ComSpec || "cmd.exe", "/d", "/c", "backlog.cmd", ...args];
  return ["backlog", ...args];
}

async function backlogRun(args) {
  const proc = Bun.spawn(backlogInvocation(args), { stdout: "pipe", stderr: "pipe" });
  const out = (await proc.stdout.text()).trim();
  const err = (await proc.stderr.text()).trim();
  return { code: await proc.exited, out, err };
}

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
    case "backlog": {
      const sub = argv[1];
      const dry = argv.includes("--dry-run");
      if (sub === "status") {
        let available = false, version = "";
        try { const r = await backlogRun(["--version"]); available = r.code === 0; version = r.out.split("\n")[0] || r.out; } catch { /* not installed */ }
        json({ available, version, bin: backlogInvocation([]).join(" "), root: process.env.BACKLOG_CWD || null });
        break;
      }
      if (sub === "export") {
        const title = flag("title");
        if (!title) { console.error("[goalctl] Failed to backlog export: --title is required"); process.exit(2); }
        const args = ["task", "create", title];
        if (flag("desc")) args.push("-d", flag("desc"));
        for (const ac of flags("ac")) args.push("--ac", ac);
        if (flags("label").length) args.push("-l", flags("label").join(","));
        if (dry) { json({ dryRun: true, command: ["backlog", ...args].join(" ") }); break; }
        const r = await backlogRun(args);
        if (r.code !== 0) { console.error(`[goalctl] Failed to backlog export: ${r.err || r.out}`); process.exit(1); }
        const m = r.out.match(/Created task (TASK-\d+)/);
        const taskId = m ? m[1] : null;
        if (flag("id") && taskId) await store.checkpoint(flag("id"), { evidence: [`backlog ${taskId}: ${title}`] });
        json({ taskId, title, raw: r.out }); break;
      }
      if (sub === "sync") {
        const task = flag("task"), status = flag("status");
        if (!task || !status) { console.error("[goalctl] Failed to backlog sync: --task and --status are required"); process.exit(2); }
        const args = ["task", "edit", task, "-s", status];
        if (dry) { json({ dryRun: true, command: ["backlog", ...args].join(" ") }); break; }
        const r = await backlogRun(args);
        if (r.code !== 0) { console.error(`[goalctl] Failed to backlog sync: ${r.err || r.out}`); process.exit(1); }
        json({ task, status, raw: r.out }); break;
      }
      console.error("usage: goalctl backlog status|export|sync [--id|--title|--desc|--ac|--label|--task|--status|--dry-run]");
      process.exit(2);
    }
    case "doctor": {
      console.log(`bun ${Bun.version} ok`);
      console.log(`store ${store.root} ok`);
      break;
    }
    default:
      console.error("usage: goalctl open|status|checkpoint|finish|close|lesson|backlog|doctor [--id|--session|--cwd|--objective|--done|--evidence|--proof|--verify|--audit|--issue|--next|--blocker|--title|--desc|--ac|--label|--task|--status|--dry-run]");
      process.exit(2);
  }
} catch (e) {
  console.error(`[goalctl] Failed to ${cmd || "run"}: ${e.message}`);
  process.exit(1);
}
