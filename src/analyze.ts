// Deterministic claim-vs-evidence engine — the part that must NEVER over-accuse.
//
// We extract ASSERTIVE claims from the assistant's text (excluding hypotheticals
// like "once tests pass" / "to make the build green"), then cross-check each
// against the session's actual tool-call record:
//   - verified    : a relevant command ran and succeeded (exit 0 / not is_error)
//   - contradicted: a relevant command ran and FAILED → an actual lie, cited
//   - unsupported : the claim was made but no relevant command was observed
// An LLM is never in this path. Only cited tool evidence moves the score, so a
// "lie" is always backed by a real failed command, never a vibe.

import type { ParsedSession, ToolCall } from "./parse.js";

export type ClaimStatus = "verified" | "contradicted" | "unsupported";

export interface ClaimReceipt {
  kind: string;
  /** The sentence the claim was found in (trimmed). */
  claim: string;
  status: ClaimStatus;
  /** Human-readable, cited evidence. */
  evidence: string;
}

export interface ProjectAuditContext {
  /** Changed files from git status/diff. If omitted, we fall back to transcript edit paths. */
  changedFiles?: string[];
  /** Scripts from the nearest package.json, when available. */
  packageScripts?: Record<string, string>;
  /** Where changedFiles came from. */
  source?: "git" | "transcript" | "none";
}

export interface AnalyzeOptions {
  project?: ProjectAuditContext;
}

interface ClaimSpec {
  kind: string;
  /** Assertive claim patterns (already past the hedge filter). */
  assert: RegExp;
  /** Which Bash commands count as evidence for this claim. */
  cmd: RegExp;
  /** Past-tense verb for messages. */
  noun: string;
}

const SPECS: ClaimSpec[] = [
  {
    kind: "tests",
    assert: /\b(all\s+)?(tests?|test\s+suite|unit\s+tests?)\s+(pass|passed|passing|are\s+green|succeed|succeeded)\b|\b(tests?|suite)\s+(?:are\s+)?green\b|✓\s*tests?\b/i,
    cmd: /\b(npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|vitest|jest|mocha|pytest|go\s+test|cargo\s+test|rspec|phpunit|gradle\s+test)\b/i,
    noun: "tests",
  },
  {
    kind: "build",
    assert: /\b(the\s+)?build\s+(passes|passed|succeeds|succeeded|is\s+clean|is\s+green|works|completed)\b|\bbuilds?\s+(cleanly|successfully)\b|\bit\s+compiles\b|\bcompiles\s+(cleanly|fine|without\s+errors)\b/i,
    cmd: /\b(npm\s+run\s+build|pnpm\s+(run\s+)?build|yarn\s+build|next\s+build|vite\s+build|tsc\b|cargo\s+build|go\s+build|make\b|gradle\s+build|webpack)\b/i,
    noun: "build",
  },
  {
    kind: "typecheck",
    assert: /\b(typecheck|type-check|type\s+check)\s+(passes|passed|is\s+clean|clean)\b|\bno\s+type\s+errors?\b|\btypes?\s+(check\s+out|are\s+clean)\b/i,
    cmd: /\b(tsc\b|tsc\s+--noemit|npm\s+run\s+typecheck|pnpm\s+(run\s+)?typecheck|type-check|mypy|pyright)\b/i,
    noun: "typecheck",
  },
  {
    kind: "lint",
    assert: /\b(lint(ing)?|eslint|ruff)\s+(passes|passed|is\s+clean|clean|green)\b|\bno\s+lint\s+(errors?|warnings?)\b/i,
    cmd: /\b(eslint|npm\s+run\s+lint|pnpm\s+(run\s+)?lint|yarn\s+lint|ruff|flake8|golangci-lint|next\s+lint)\b/i,
    noun: "lint",
  },
  {
    kind: "migration",
    assert: /\b(ran|applied|executed|completed)\s+(the\s+)?migrations?\b|\bmigrations?\s+(ran|applied|complete|succeeded)\b|\bdatabase\s+migrated\b/i,
    cmd: /\b(migrat|prisma\s+migrate|drizzle-kit|alembic|rails\s+db:migrate|knex\s+migrate|sequelize\s+db:migrate)\b/i,
    noun: "the migration",
  },
  {
    kind: "deploy",
    assert: /\b(deployed|shipped\s+to\s+production|pushed\s+live|is\s+live|deploy(ment)?\s+(succeeded|complete|is\s+done))\b/i,
    cmd: /\b(vercel|netlify|deploy|gcloud\s+run\s+deploy|kubectl\s+apply|fly\s+deploy|wrangler\s+(deploy|publish)|aws\s+s3\s+sync|sst\s+deploy)\b/i,
    noun: "the deploy",
  },
];

const TEST_CMD = SPECS.find((s) => s.kind === "tests")!.cmd;
const BUILD_CMD = SPECS.find((s) => s.kind === "build")!.cmd;
const TYPECHECK_CMD = SPECS.find((s) => s.kind === "typecheck")!.cmd;
const LINT_CMD = SPECS.find((s) => s.kind === "lint")!.cmd;
const MIGRATION_CMD = SPECS.find((s) => s.kind === "migration")!.cmd;
const DEPLOY_CMD = SPECS.find((s) => s.kind === "deploy")!.cmd;
const INSTALL_CMD =
  /\b(npm\s+(install|i|ci)|pnpm\s+(install|i)|yarn\s+(install|add)|bun\s+install|pip\s+install|poetry\s+install|bundle\s+install|cargo\s+fetch|go\s+mod\s+(download|tidy))\b/i;
const ANY_VERIFY_CMD = new RegExp(
  [
    TEST_CMD.source,
    BUILD_CMD.source,
    TYPECHECK_CMD.source,
    LINT_CMD.source,
  ].join("|"),
  "i"
);

const GENERATED_OR_VENDOR =
  /(^|\/)(node_modules|\.next|dist|build|coverage|\.git|vendor|target|\.turbo|\.cache)(\/|$)/i;
const SOURCE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|cpp|c|h|hpp|css|scss|sass|vue|svelte)$/i;
const TEST_FILE = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./i;
const DB_FILE =
  /(^|\/)(supabase|migrations?|prisma|drizzle|db|database)(\/|$)|schema\.sql$|schema\.prisma$|migration/i;
const DEP_FILE =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements\.txt|pyproject\.toml|poetry\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock)$/i;

// Hedge words that, when they precede a claim, make it non-assertive.
const HEDGE = /\b(if|once|to|should|when|make|makes|making|let'?s|will|need|needs|would|could|after|so\s+that|in\s+order\s+to|trying\s+to|attempt|hopefully|expect|should\s+now|run\s+the|running\s+the|let\s+me|i'?ll|going\s+to)\b/i;

// Meta words: a sentence ABOUT claims/receipts/verification as concepts (docs,
// or a tool that talks about this domain) is not a work-claim. Cheap guard
// against self-reference and prose that merely discusses verification.
const META = /\b(agentreceipt|trust\s+score|archetype|tollgate|receipts?|claims?|verifier|guardrails?)\b/i;

function sentences(text: string): string[] {
  // Strip fenced/inline code and markdown markers first — real work-claims live
  // in prose, not in code samples or headings/quotes.
  const noCode = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  return noCode
    .split(/\n+|(?<=[.!?])\s+|•|·|—\s/)
    .map((s) => s.replace(/^[#>\-*\d.\s]+/, "").trim())
    .filter(
      (s) => s.length >= 10 && s.length <= 180 && /[a-z]/i.test(s) && !META.test(s)
    );
}

function isAssertive(sentence: string, matchIdx: number): boolean {
  // Reject if a hedge word appears in the ~40 chars before the claim match.
  const before = sentence.slice(Math.max(0, matchIdx - 40), matchIdx);
  return !HEDGE.test(before);
}

/** Cite the part of a (possibly long, compound) command that actually matched
 *  the evidence regex — so `tsc` is shown, not an unrelated earlier segment. */
function matchWindow(cmd: string, re: RegExp): string {
  const m = new RegExp(re.source, re.flags.replace("g", "")).exec(cmd);
  if (!m) return cmd.slice(0, 70);
  const start = Math.max(0, m.index - 6);
  const frag = cmd.slice(start, m.index + m[0].length + 36).trim();
  return (start > 0 ? "…" : "") + frag + (m.index + m[0].length + 36 < cmd.length ? "…" : "");
}

function bashCommands(toolCalls: ToolCall[]): { call: ToolCall; cmd: string }[] {
  return toolCalls
    .filter((t) => t.name === "Bash" && typeof t.input.command === "string")
    .map((t) => ({ call: t, cmd: String(t.input.command) }));
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files.map((f) => f.trim()).filter(Boolean))]
    .filter((f) => !GENERATED_OR_VENDOR.test(f))
    .sort();
}

function touchedFiles(session: ParsedSession): string[] {
  return uniqueFiles(
    session.toolCalls.map((t) => t.touchedFile).filter((f): f is string => !!f)
  );
}

function fileSummary(files: string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return `${files.length} changed file${files.length === 1 ? "" : "s"}${
    shown ? `: ${shown}${files.length > 3 ? ", ..." : ""}` : ""
  }`;
}

function hasScript(project: ProjectAuditContext | undefined, name: string): boolean {
  return typeof project?.packageScripts?.[name] === "string";
}

function lastRelevant(
  bash: { call: ToolCall; cmd: string }[],
  re: RegExp
): { call: ToolCall; cmd: string } | null {
  const matches = bash.filter((b) => re.test(b.cmd));
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function wasObserved(bash: { call: ToolCall; cmd: string }[], re: RegExp): boolean {
  return lastRelevant(bash, re) !== null;
}

function passedLast(bash: { call: ToolCall; cmd: string }[], re: RegExp): boolean {
  return lastRelevant(bash, re)?.call.ok === true;
}

function checkFinding(
  bash: { call: ToolCall; cmd: string }[],
  re: RegExp,
  kind: string,
  label: string,
  changed: string[]
): ClaimReceipt | null {
  const last = lastRelevant(bash, re);
  if (!last) return null;
  const cited = matchWindow(last.cmd, re);
  if (last.call.ok) {
    return {
      kind,
      claim: `${label} ran after changes`,
      status: "verified",
      evidence: `${label.toLowerCase()} passed after ${fileSummary(changed)} — \`${cited}\` exited 0`,
    };
  }
  return {
    kind,
    claim: `${label} failed during the session`,
    status: "contradicted",
    evidence: `${label.toLowerCase()} failed after ${fileSummary(changed)} — \`${cited}\`${
      last.call.exitCode != null ? ` exited ${last.call.exitCode}` : " errored"
    }`,
  };
}

function auditWork(
  session: ParsedSession,
  bash: { call: ToolCall; cmd: string }[],
  edits: number,
  project?: ProjectAuditContext
): ClaimReceipt[] {
  const changed = uniqueFiles(
    project?.changedFiles?.length ? project.changedFiles : touchedFiles(session)
  );
  if (changed.length === 0) {
    return edits > 0
      ? [
          {
            kind: "verification",
            claim: "Edits were recorded but changed files were not identified",
            status: "unsupported",
            evidence: `${edits} edit tool call(s) were recorded, but no file paths were available to audit`,
          },
        ]
      : [];
  }

  const findings: ClaimReceipt[] = [];
  const codeFiles = changed.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f));
  const testFiles = changed.filter((f) => TEST_FILE.test(f));
  const dbFiles = changed.filter((f) => DB_FILE.test(f));
  const depFiles = changed.filter((f) => DEP_FILE.test(f));
  const source = project?.source === "git" ? "git diff" : "transcript edits";

  const checks = [
    checkFinding(bash, TEST_CMD, "tests", "Tests", changed),
    checkFinding(bash, BUILD_CMD, "build", "Build", changed),
    checkFinding(bash, TYPECHECK_CMD, "typecheck", "Typecheck", changed),
    checkFinding(bash, LINT_CMD, "lint", "Lint", changed),
  ].filter((f): f is ClaimReceipt => !!f);
  findings.push(...checks);

  const anyVerification = wasObserved(bash, ANY_VERIFY_CMD);
  if ((codeFiles.length > 0 || testFiles.length > 0) && !anyVerification) {
    findings.push({
      kind: "verification",
      claim: "Changed code without observed verification",
      status: "unsupported",
      evidence: `${source} shows ${fileSummary(changed)}, but no test/build/typecheck/lint command was observed`,
    });
  }

  if (codeFiles.length > 0 && hasScript(project, "test") && !wasObserved(bash, TEST_CMD)) {
    findings.push({
      kind: "tests",
      claim: "Tests were skipped for changed code",
      status: "unsupported",
      evidence: `package.json has a test script and ${fileSummary(codeFiles)}, but no test command was observed`,
    });
  }

  if (
    codeFiles.length > 0 &&
    (hasScript(project, "typecheck") || hasScript(project, "type-check")) &&
    !wasObserved(bash, TYPECHECK_CMD)
  ) {
    findings.push({
      kind: "typecheck",
      claim: "Typecheck was skipped for changed code",
      status: "unsupported",
      evidence: `package.json has a typecheck script and ${fileSummary(codeFiles)}, but no typecheck command was observed`,
    });
  }

  if (codeFiles.length > 0 && hasScript(project, "build") && !wasObserved(bash, BUILD_CMD)) {
    findings.push({
      kind: "build",
      claim: "Build was skipped for changed code",
      status: "unsupported",
      evidence: `package.json has a build script and ${fileSummary(codeFiles)}, but no build command was observed`,
    });
  }

  if (codeFiles.length > 0 && hasScript(project, "lint") && !wasObserved(bash, LINT_CMD)) {
    findings.push({
      kind: "lint",
      claim: "Lint was skipped for changed code",
      status: "unsupported",
      evidence: `package.json has a lint script and ${fileSummary(codeFiles)}, but no lint command was observed`,
    });
  }

  if (dbFiles.length > 0 && !wasObserved(bash, MIGRATION_CMD)) {
    findings.push({
      kind: "migration",
      claim: "Database/schema changes were not migration-verified",
      status: "unsupported",
      evidence: `${fileSummary(dbFiles)}, but no migration/schema command was observed`,
    });
  }

  if (
    depFiles.length > 0 &&
    !wasObserved(bash, INSTALL_CMD) &&
    !passedLast(bash, BUILD_CMD) &&
    !passedLast(bash, TEST_CMD)
  ) {
    findings.push({
      kind: "dependencies",
      claim: "Dependency changes were not installed or rebuilt",
      status: "unsupported",
      evidence: `${fileSummary(depFiles)}, but no install/build/test command was observed afterward`,
    });
  }

  if (wasObserved(bash, DEPLOY_CMD) && !passedLast(bash, DEPLOY_CMD)) {
    const deploy = lastRelevant(bash, DEPLOY_CMD)!;
    findings.push({
      kind: "deploy",
      claim: "Deploy command failed",
      status: "contradicted",
      evidence: `deploy command failed — \`${matchWindow(deploy.cmd, DEPLOY_CMD)}\`${
        deploy.call.exitCode != null ? ` exited ${deploy.call.exitCode}` : " errored"
      }`,
    });
  }

  return findings;
}

export interface AnalysisResult {
  receipts: ClaimReceipt[];
  counts: { verified: number; contradicted: number; unsupported: number };
  edits: number;
  toolCalls: number;
}

export function analyze(session: ParsedSession, options: AnalyzeOptions = {}): AnalysisResult {
  const bash = bashCommands(session.toolCalls);
  const edits = session.toolCalls.filter((t) =>
    ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(t.name)
  ).length;
  const sents = sentences(session.assistantText);
  const receipts: ClaimReceipt[] = [];
  const seen = new Set<string>();

  for (const spec of SPECS) {
    for (const s of sents) {
      const m = spec.assert.exec(s);
      if (!m) continue;
      if (!isAssertive(s, m.index)) continue;
      const key = `${spec.kind}::${s.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const relevant = bash.filter((b) => spec.cmd.test(b.cmd));
      const succeeded = relevant.filter((b) => b.call.ok);
      const failed = relevant.filter((b) => !b.call.ok);

      let status: ClaimStatus;
      let evidence: string;
      if (succeeded.length > 0) {
        status = "verified";
        const c = matchWindow(succeeded[succeeded.length - 1].cmd, spec.cmd);
        evidence = `${spec.noun} ran and passed — \`${c}\` exited 0`;
      } else if (failed.length > 0) {
        status = "contradicted";
        const f = failed[failed.length - 1];
        const ec = f.call.exitCode;
        evidence = `claimed ${spec.noun} passed, but \`${matchWindow(f.cmd, spec.cmd)}\`${
          ec != null ? ` exited ${ec}` : " errored"
        }`;
      } else {
        status = "unsupported";
        evidence = `claimed ${spec.noun} passed, but no ${spec.noun} command was run in this session`;
      }
      receipts.push({ kind: spec.kind, claim: s.slice(0, 160), status, evidence });
    }
  }

  // "Fixed / implemented" claims → require at least one edit somewhere; if a
  // specific file is named and never touched, flag unsupported.
  const fixSents = sents.filter((s) =>
    /\b(fixed|resolved|implemented|added|updated|patched|corrected)\b/i.test(s) &&
    !HEDGE.test(s.slice(0, 24))
  );
  if (fixSents.length > 0) {
    const touched = session.toolCalls
      .map((t) => t.touchedFile)
      .filter((f): f is string => !!f);
    if (edits === 0) {
      receipts.push({
        kind: "fix",
        claim: fixSents[0].slice(0, 160),
        status: "unsupported",
        evidence: "claimed to fix/implement something, but no file was edited or written in this session",
      });
    } else {
      receipts.push({
        kind: "fix",
        claim: fixSents[0].slice(0, 160),
        status: "verified",
        evidence: `${edits} file edit(s) recorded${touched.length ? ` — e.g. ${touched[0]}` : ""}`,
      });
    }
  }

  receipts.push(...auditWork(session, bash, edits, options.project));

  // Counts reflect every distinct claim we detected (drives the score).
  const counts = {
    verified: receipts.filter((r) => r.status === "verified").length,
    contradicted: receipts.filter((r) => r.status === "contradicted").length,
    unsupported: receipts.filter((r) => r.status === "unsupported").length,
  };
  // Display order: the dramatic + damning first (contradicted → unsupported →
  // verified), then cap so the card stays readable.
  const rank = { contradicted: 0, unsupported: 1, verified: 2 } as const;
  receipts.sort((a, b) => rank[a.status] - rank[b.status]);
  // Collapse claims backed by the SAME evidence (e.g. ten "typecheck clean"
  // lines all citing the same tsc run) into one card row.
  const byEvidence = new Set<string>();
  const display = receipts
    .filter((r) => {
      const k = `${r.kind}|${r.status}|${r.evidence}`;
      if (byEvidence.has(k)) return false;
      byEvidence.add(k);
      return true;
    })
    .slice(0, 6);
  return { receipts: display, counts, edits, toolCalls: session.toolCalls.length };
}
