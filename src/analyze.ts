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

export interface AnalysisResult {
  receipts: ClaimReceipt[];
  counts: { verified: number; contradicted: number; unsupported: number };
  edits: number;
  toolCalls: number;
}

export function analyze(session: ParsedSession): AnalysisResult {
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
