// Locate Claude Code session transcripts on disk. Claude Code stores them at
// ~/.claude/projects/<slugified-cwd>/<uuid>.jsonl. We find the most recently
// modified one (optionally scoped to the current project).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionFile {
  path: string;
  mtimeMs: number;
  project: string;
}

export function projectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function listSessions(): SessionFile[] {
  const root = projectsDir();
  const out: SessionFile[] = [];
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        out.push({ path: path.join(dir, f), mtimeMs: st.mtimeMs, project: proj });
      } catch {
        /* skip */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Most recent session overall, or the most recent within the project whose
 *  slug matches the current working directory. */
export function latestSession(scopeToCwd = true): SessionFile | null {
  const all = listSessions();
  if (all.length === 0) return null;
  if (scopeToCwd) {
    const slug = "-" + process.cwd().replace(/^\//, "").replace(/[/.]/g, "-");
    const scoped = all.filter((s) => s.project === slug);
    if (scoped.length > 0) return scoped[0];
  }
  return all[0];
}
