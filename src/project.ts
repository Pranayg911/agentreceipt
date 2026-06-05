import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectAuditContext } from "./analyze.js";

const GENERATED_OR_VENDOR =
  /(^|\/)(node_modules|\.next|dist|build|coverage|\.git|vendor|target|\.turbo|\.cache)(\/|$)/i;

function parseGitStatus(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const file = raw.includes(" -> ") ? raw.split(" -> ").pop() ?? raw : raw;
    if (file && !GENERATED_OR_VENDOR.test(file)) files.push(file);
  }
  return [...new Set(files)].sort();
}

function gitChangedFiles(cwd: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return parseGitStatus(out);
  } catch {
    return null;
  }
}

function findPackageJson(cwd: string): string | null {
  let dir = cwd;
  const home = os.homedir();
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === home) break;
    dir = path.dirname(dir);
  }
  return null;
}

function packageScripts(cwd: string): Record<string, string> {
  const pkg = findPackageJson(cwd);
  if (!pkg) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      })
    );
  } catch {
    return {};
  }
}

export function collectProjectContext(cwd = process.cwd()): ProjectAuditContext {
  const gitFiles = gitChangedFiles(cwd);
  return {
    changedFiles: gitFiles ?? [],
    packageScripts: packageScripts(cwd),
    source: gitFiles && gitFiles.length > 0 ? "git" : "none",
  };
}
