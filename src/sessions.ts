// Locate supported AI coding-agent session artifacts.
//
// Support levels:
// - Claude Code: full JSONL transcript parsing from ~/.claude/projects.
// - Codex: full-ish rollout JSONL parsing from ~/.codex/sessions, discovered
//   through Codex state DB when present.
// - Cursor: best-effort checkpoint metadata from Cursor's app storage. Cursor
//   does not currently expose a stable Claude-like transcript file, so we use
//   checkpoint request files as repo evidence and mark the transcript as limited.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentKind = "claude" | "codex" | "cursor";

export interface SessionFile {
  path: string;
  mtimeMs: number;
  project: string;
  agent: AgentKind;
  cwd?: string;
  title?: string;
}

export interface LatestSessionOptions {
  agent?: AgentKind | "auto";
  scopeToCwd?: boolean;
  cwd?: string;
}

function home(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function projectsDir(): string {
  return home(".claude", "projects");
}

function slugForCwd(cwd: string): string {
  return "-" + cwd.replace(/^\//, "").replace(/[/.]/g, "-");
}

function pathMatchesCwd(candidate: string | undefined, cwd: string): boolean {
  if (!candidate) return false;
  const a = path.resolve(candidate);
  const b = path.resolve(cwd);
  return a === b || b.startsWith(a + path.sep) || a.startsWith(b + path.sep);
}

function listClaudeSessions(): SessionFile[] {
  const root = projectsDir();
  const out: SessionFile[] = [];
  for (const proj of safeReadDir(root)) {
    const dir = path.join(root, proj);
    for (const f of safeReadDir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      out.push({
        path: file,
        mtimeMs: statMtime(file),
        project: proj,
        agent: "claude",
      });
    }
  }
  return out;
}

function sqliteJson(db: string, sql: string): unknown[] {
  try {
    const out = execFileSync("sqlite3", ["-json", db, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out || "[]") as unknown[];
  } catch {
    return [];
  }
}

function q(s: string): string {
  return s.replace(/'/g, "''");
}

function listCodexSessions(): SessionFile[] {
  const db = home(".codex", "state_5.sqlite");
  const rows = sqliteJson(
    db,
    "select id, rollout_path, cwd, title, updated_at_ms from threads where archived = 0 order by updated_at_ms desc"
  ) as Array<{
    id?: string;
    rollout_path?: string;
    cwd?: string;
    title?: string;
    updated_at_ms?: number;
  }>;

  const fromDb = rows
    .filter((r) => r.rollout_path && fs.existsSync(r.rollout_path))
    .map((r): SessionFile => ({
      path: String(r.rollout_path),
      mtimeMs: Number(r.updated_at_ms) || statMtime(String(r.rollout_path)),
      project: r.cwd ? path.basename(r.cwd) : String(r.id ?? "codex"),
      agent: "codex",
      cwd: r.cwd,
      title: r.title,
    }));

  if (fromDb.length > 0) return fromDb;

  const root = home(".codex", "sessions");
  const out: SessionFile[] = [];
  function walk(dir: string) {
    for (const name of safeReadDir(dir)) {
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(file);
      else if (name.endsWith(".jsonl")) {
        out.push({
          path: file,
          mtimeMs: st.mtimeMs,
          project: "codex",
          agent: "codex",
        });
      }
    }
  }
  walk(root);
  return out;
}

function decodeFileUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(uri.slice("file://".length));
}

function cursorWorkspaceMap(): Map<string, string> {
  const root = home("Library", "Application Support", "Cursor", "User", "workspaceStorage");
  const map = new Map<string, string>();
  for (const id of safeReadDir(root)) {
    const file = path.join(root, id, "workspace.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { folder?: string };
      if (parsed.folder) map.set(id, decodeFileUri(parsed.folder));
    } catch {
      /* skip */
    }
  }
  return map;
}

function listCursorSessions(): SessionFile[] {
  const root = home(
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage",
    "anysphere.cursor-commits",
    "checkpoints"
  );
  const workspaces = cursorWorkspaceMap();
  const out: SessionFile[] = [];
  for (const id of safeReadDir(root)) {
    const file = path.join(root, id, "metadata.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        agentRequestId?: string;
        workspaceId?: string;
        startTrackingDateUnixMilliseconds?: number;
      };
      const cwd = parsed.workspaceId ? workspaces.get(parsed.workspaceId) : undefined;
      out.push({
        path: file,
        mtimeMs: Number(parsed.startTrackingDateUnixMilliseconds) || statMtime(file),
        project: cwd ? path.basename(cwd) : parsed.workspaceId ?? "cursor",
        agent: "cursor",
        cwd,
        title: parsed.agentRequestId,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function listSessions(agent: AgentKind | "auto" = "auto"): SessionFile[] {
  const sessions = [
    ...(agent === "auto" || agent === "claude" ? listClaudeSessions() : []),
    ...(agent === "auto" || agent === "codex" ? listCodexSessions() : []),
    ...(agent === "auto" || agent === "cursor" ? listCursorSessions() : []),
  ];
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Most recent supported session, optionally scoped to the current project. */
export function latestSession(
  scopeToCwdOrOptions: boolean | LatestSessionOptions = true
): SessionFile | null {
  const opts =
    typeof scopeToCwdOrOptions === "boolean"
      ? { scopeToCwd: scopeToCwdOrOptions }
      : scopeToCwdOrOptions;
  const cwd = opts.cwd ?? process.cwd();
  const all = listSessions(opts.agent ?? "auto");
  if (all.length === 0) return null;

  if (opts.scopeToCwd ?? true) {
    const claudeSlug = slugForCwd(cwd);
    const scoped = all.filter((s) => {
      if (s.agent === "claude") return s.project === claudeSlug;
      return pathMatchesCwd(s.cwd, cwd);
    });
    if (scoped.length > 0) return scoped[0];
  }

  return all[0] ?? null;
}

export function codexThreadForPath(file: string): { cwd?: string; title?: string } {
  const db = home(".codex", "state_5.sqlite");
  const rows = sqliteJson(
    db,
    `select cwd, title from threads where rollout_path = '${q(file)}' limit 1`
  ) as Array<{ cwd?: string; title?: string }>;
  return rows[0] ?? {};
}
