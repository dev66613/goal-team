// lib/goal-store.mjs — durable goal state with locks. Sole owner of goal JSON files.
import { mkdir, readFile, writeFile, rm, open, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export function hashCwd(cwd) {
  // Windows paths are case-insensitive: normalise before hashing or one cwd yields
  // two index slots (orphan-record bug in 1.1.23).
  const key = process.platform === "win32" ? String(cwd).toLowerCase() : String(cwd);
  return createHash("sha1").update(key).digest("hex");
}

const APPEND_FIELDS = new Set([
  "requirements", "mustNotRegress", "constraints", "evidence", "inspectionEvidence",
  "validationProof", "verificationResults", "requirementCoverage", "doneSoFar",
  "completionAudit", "resolvedIssues",
]);
const REPLACE_FIELDS = new Set(["remaining", "blockers", "discoveredIssues"]);
const LOCK_STALE_MS = 10_000;

// Identifiers become file names: sanitize to keep every path inside the state root
// (no traversal via --id or a hostile session_id in a hook payload).
const safeKey = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
// Sanitizing alone COLLIDES ("a/b" and "a_b" share one file and would mix two sessions'
// state): add a short digest so distinct ids always map to distinct files.
const fileKey = (s) =>
  `${safeKey(s).slice(0, 32)}-${createHash("sha1").update(String(s)).digest("hex").slice(0, 8)}`;

export class GoalStore {
  constructor({ stateRoot }) {
    this.root = stateRoot;
    this.goals = path.join(stateRoot, "goals");
    this.bySession = path.join(stateRoot, "by-session");
    this.byCwd = path.join(stateRoot, "by-cwd-session");
    this.locks = path.join(stateRoot, "locks");
    this.lessons = path.join(stateRoot, "lessons.md");
  }

  async init() {
    for (const d of [this.goals, this.bySession, this.byCwd, this.locks]) await mkdir(d, { recursive: true });
  }

  goalPath(id) { return path.join(this.goals, `${fileKey(id)}.json`); }
  sessionPath(sid) { return path.join(this.bySession, `${fileKey(sid)}.json`); }
  cwdPath(cwd, sid) { return path.join(this.byCwd, `${hashCwd(cwd)}--${fileKey(sid)}.json`); }

  async withLock(id, fn) {
    // Same fileKey as the data files: a raw id like "a/b" would target locks/a/b.lock (ENOENT).
    const p = path.join(this.locks, `${fileKey(id)}.lock`);
    for (let i = 0; i < 40; i++) {
      try {
        const h = await open(p, "wx");
        try { return await fn(); } finally { await h.close(); await rm(p, { force: true }); }
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const st = await stat(p).catch(() => null);
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await rm(p, { force: true });
        await Bun.sleep(50);
      }
    }
    throw new Error(`lock timeout for ${id}`);
  }

  async load(id) { return JSON.parse(await readFile(this.goalPath(id), "utf8")); }
  async loadBySession(sid) { return this.#loadOptional(this.sessionPath(sid)); }
  async loadByCwdSession(cwd, sid) { return this.#loadOptional(this.cwdPath(cwd, sid)); }
  async #loadOptional(p) {
    try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
  }

  async #writeGoal(goal) {
    const json = JSON.stringify(goal, null, 2);
    await writeFile(this.goalPath(goal.id), json);
    await writeFile(this.sessionPath(goal.sessionId), json);
    await writeFile(this.cwdPath(goal.cwd, goal.sessionId), json);
    return goal;
  }

  async open({ sessionId, cwd, objective }) {
    return this.withLock(sessionId, async () => {
      // Idempotent per session: a second /goal must not orphan the first goal's index.
      const existing = await this.#loadOptional(this.sessionPath(sessionId));
      if (existing && existing.status === "active") return existing;
      const goal = {
        id: randomUUID(), sessionId, cwd, objective,
        status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        drift: 0,
        discoveredIssues: [], resolvedIssues: [], remaining: [], blockers: [],
        doneSoFar: [], evidence: [], inspectionEvidence: [], validationProof: [],
        verificationResults: [], requirementCoverage: [], completionAudit: [],
        history: [],
      };
      return this.#writeGoal(goal);
    });
  }

  async checkpoint(id, patch) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      for (const [k, v] of Object.entries(patch)) {
        if (!Array.isArray(v)) continue;
        if (APPEND_FIELDS.has(k)) goal[k] = [...new Set([...(goal[k] || []), ...v])];
        else if (REPLACE_FIELDS.has(k)) goal[k] = [...new Set(v)];
      }
      goal.updatedAt = new Date().toISOString();
      goal.drift = 0; // a checkpoint resets the drift counter (hook bumps it per tool call)
      return this.#writeGoal(goal);
    });
  }

  // Drift accounting: tool calls since the last checkpoint.
  async bumpDrift(id) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      goal.drift = (goal.drift || 0) + 1;
      return this.#writeGoal(goal);
    });
  }

  async finish(id, patch) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      if ((goal.remaining || []).length && !patch.clearRemaining) {
        throw new Error(`finish refused: remaining work still recorded (${goal.remaining.length} items)`);
      }
      for (const [k, v] of Object.entries(patch)) {
        if (!Array.isArray(v)) continue;
        if (APPEND_FIELDS.has(k)) goal[k] = [...new Set([...(goal[k] || []), ...v])];
        else if (REPLACE_FIELDS.has(k)) goal[k] = [...new Set(v)];
      }
      goal.status = "complete";
      goal.closedAt = goal.updatedAt = new Date().toISOString();
      await this.#writeGoal(goal);
      // A finished goal must not linger in the "active" indexes (D9-style orphan) —
      // otherwise the hook would block a fresh goal in the same session.
      await this.#clearIndexes(goal);
      return goal;
    });
  }

  async close(id, { status }) {
    return this.withLock(id, async () => {
      const goal = await this.load(id);
      goal.status = status;
      goal.closedAt = goal.updatedAt = new Date().toISOString();
      await this.#writeGoal(goal);
      // remove every index record so no stale "active" copy survives (D9)
      await this.#clearIndexes(goal);
      return goal;
    });
  }

  async #clearIndexes(goal) {
    for (const p of [this.sessionPath(goal.sessionId), this.cwdPath(goal.cwd, goal.sessionId)]) {
      await rm(p, { force: true });
    }
  }

  async lesson(text) {
    await writeFile(this.lessons, `## ${new Date().toISOString()}\n${text}\n\n`, { flag: "a" });
  }
}
