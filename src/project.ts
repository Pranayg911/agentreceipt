import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentReceiptPolicy,
  CiCheckEvidence,
  PolicyRequirement,
  ProjectAuditContext,
} from "./analyze.js";

const GENERATED_OR_VENDOR =
  /(^|\/)(node_modules|\.next|dist|build|coverage|\.git|vendor|target|\.turbo|\.cache)(\/|$)/i;
const POLICY_FILES = [".agentreceipt.json", "agentreceipt.config.json"];
const POLICY_REQUIREMENTS = new Set<PolicyRequirement>([
  "tests",
  "build",
  "typecheck",
  "lint",
  "migration",
  "ci",
]);

export interface CollectProjectOptions {
  ciEvidenceFile?: string | null;
  policyFile?: string | null;
}

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

function readJsonFile(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function packageJson(cwd: string): Record<string, unknown> | null {
  const pkg = findPackageJson(cwd);
  const parsed = pkg ? readJsonFile(pkg) : null;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

function packageScripts(cwd: string): Record<string, string> {
  const parsed = packageJson(cwd);
  if (!parsed) return {};
  const scripts = parsed.scripts;
  if (!scripts || typeof scripts !== "object") return {};
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    })
  );
}

function normalizePolicy(raw: unknown): AgentReceiptPolicy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const policy: AgentReceiptPolicy = {};

  if (typeof obj.minTrust === "number" && Number.isFinite(obj.minTrust)) {
    policy.minTrust = Math.max(0, Math.min(100, Math.round(obj.minTrust)));
  }
  if (typeof obj.allowWarnings === "boolean") {
    policy.allowWarnings = obj.allowWarnings;
  }

  const required = Array.isArray(obj.require) ? obj.require : Array.isArray(obj.required) ? obj.required : [];
  const normalized = required
    .map((value) => String(value).toLowerCase())
    .filter((value): value is PolicyRequirement => POLICY_REQUIREMENTS.has(value as PolicyRequirement));
  if (normalized.length > 0) policy.require = [...new Set(normalized)];

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function findPolicyFile(cwd: string, explicit?: string | null): string | null {
  if (explicit) return path.resolve(cwd, explicit);
  let dir = cwd;
  const home = os.homedir();
  while (dir !== path.dirname(dir)) {
    for (const name of POLICY_FILES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (dir === home) break;
    dir = path.dirname(dir);
  }
  return null;
}

function readPolicy(cwd: string, explicit?: string | null): AgentReceiptPolicy | undefined {
  const policyFile = findPolicyFile(cwd, explicit);
  const fromFile = policyFile ? normalizePolicy(readJsonFile(policyFile)) : undefined;
  if (fromFile) return fromFile;

  const pkg = packageJson(cwd);
  return normalizePolicy(pkg?.agentreceipt);
}

function normalizeConclusion(value: unknown): CiCheckEvidence["conclusion"] {
  const conclusion = typeof value === "string" ? value : null;
  switch (conclusion) {
    case "success":
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "neutral":
    case "skipped":
    case "startup_failure":
      return conclusion;
    default:
      return null;
  }
}

function normalizeStatus(value: unknown): CiCheckEvidence["status"] {
  const status = typeof value === "string" ? value : "";
  switch (status) {
    case "queued":
    case "in_progress":
    case "completed":
      return status;
    default:
      return "unknown";
  }
}

function normalizeCiCheck(raw: unknown): CiCheckEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = String(obj.name ?? obj.workflowName ?? obj.workflow_name ?? obj.checkName ?? "").trim();
  if (!name || /agentreceipt|verify-ai-work|verify ai agent work/i.test(name)) return null;

  const detailsUrl = obj.details_url ?? obj.detailsUrl ?? obj.html_url ?? obj.htmlUrl;
  return {
    name,
    status: normalizeStatus(obj.status),
    conclusion: normalizeConclusion(obj.conclusion),
    ...(typeof detailsUrl === "string" ? { detailsUrl } : {}),
  };
}

function readCiChecks(cwd: string, file?: string | null): CiCheckEvidence[] {
  if (!file) return [];
  const parsed = readJsonFile(path.isAbsolute(file) ? file : path.resolve(cwd, file));
  if (!parsed) return [];
  const root = parsed as Record<string, unknown>;
  const rawChecks = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root.checks)
      ? root.checks
      : Array.isArray(root.check_runs)
        ? root.check_runs
        : [];
  return rawChecks
    .map(normalizeCiCheck)
    .filter((check): check is CiCheckEvidence => !!check)
    .slice(0, 30);
}

export function collectProjectContext(
  cwd = process.cwd(),
  options: CollectProjectOptions = {}
): ProjectAuditContext {
  const gitFiles = gitChangedFiles(cwd);
  const policy = readPolicy(cwd, options.policyFile);
  return {
    changedFiles: gitFiles ?? [],
    packageScripts: packageScripts(cwd),
    ciChecks: readCiChecks(cwd, options.ciEvidenceFile),
    ...(policy ? { policy } : {}),
    source: gitFiles && gitFiles.length > 0 ? "git" : "none",
  };
}
