// Build + sign the Trust Receipt — the shareable, verifiable artifact.

import { sign, verify, type SignaturePayload } from "./signer.js";
import type { JsonValue } from "./stable-json.js";
import type { AnalysisResult, ClaimReceipt } from "./analyze.js";
import type { Score } from "./score.js";
import type { ParsedSession } from "./parse.js";

export interface TrustReceipt {
  receiptId: string;
  /** Signed core — tamper-evident. */
  body: {
    sessionId: string;
    agent: string;
    trust: number;
    archetype: string;
    decision: {
      label: "ready" | "verify_first" | "do_not_merge" | "no_evidence";
      title: string;
    };
    summary: string;
    nextActions: string[];
    claims: ClaimReceipt[];
    evidenceNote?: string;
    stats: {
      toolCalls: number;
      edits: number;
      verified: number;
      contradicted: number;
      unsupported: number;
      inputTokens: number;
      outputTokens: number;
      approxCostUsd: number;
      durationMs: number | null;
    };
    generatedAt: number;
  };
  signature: SignaturePayload;
}

// Rough blended $/Mtok (Sonnet-class) just for a friendly cost line.
function approxCost(inTok: number, outTok: number): number {
  const cost = (inTok / 1_000_000) * 3 + (outTok / 1_000_000) * 15;
  return Math.round(cost * 100) / 100;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function decisionFor(
  analysis: AnalysisResult,
  sc: Score
): TrustReceipt["body"]["decision"] {
  const { verified, contradicted, unsupported } = analysis.counts;
  const total = verified + contradicted + unsupported;

  if (contradicted > 0) {
    return { label: "do_not_merge", title: "Do not merge yet" };
  }
  if (unsupported > 0 || sc.trust < 80) {
    return { label: "verify_first", title: "Needs verification" };
  }
  if (analysis.edits === 0 && total === 0) {
    return { label: "no_evidence", title: "No code-work evidence" };
  }
  return { label: "ready", title: "Reviewable with evidence" };
}

function summaryFor(analysis: AnalysisResult, sc: Score): string {
  const { verified, contradicted, unsupported } = analysis.counts;
  if (contradicted > 0) {
    return `Trust ${sc.trust}/100 because AgentReceipt found ${plural(
      contradicted,
      "failed or contradicted finding"
    )}${unsupported ? ` and ${plural(unsupported, "unproven gap")}` : ""}. Fix the failed evidence before merge.`;
  }
  if (unsupported > 0) {
    return `Trust ${sc.trust}/100 because ${plural(
      unsupported,
      "important check or claim"
    )} could not be proven from the transcript/repo evidence. Run the missing checks and regenerate the receipt.`;
  }
  if (verified > 0) {
    return `Trust ${sc.trust}/100 with ${plural(
      verified,
      "verified finding"
    )} and no observed failed or unproven claims. Still review the diff normally.`;
  }
  if (analysis.edits > 0) {
    return `Trust ${sc.trust}/100. The session recorded edits but no explicit success claims; review the diff and run normal repo checks.`;
  }
  return `Trust ${sc.trust}/100 because no edits or verification evidence were found in this session. Run AgentReceipt after an actual coding-agent change.`;
}

function actionForClaim(claim: ClaimReceipt): string | null {
  const failed = claim.status === "contradicted";
  switch (claim.kind) {
    case "tests":
      return failed
        ? "Fix the failing tests, rerun the test command after the final edit, then regenerate the receipt."
        : "Run the repo test command after the final edit, then regenerate the receipt.";
    case "build":
      return failed
        ? "Fix the build failure and rerun the build after the final edit."
        : "Run the repo build after the final edit so reviewers can trust the artifact.";
    case "typecheck":
      return failed
        ? "Fix the typecheck errors and rerun typecheck after the final edit."
        : "Run the configured typecheck after the final edit.";
    case "lint":
      return failed
        ? "Fix lint failures and rerun lint after the final edit."
        : "Run the configured lint command after the final edit.";
    case "migration":
      return "Run or validate the migration/schema command, then regenerate the receipt.";
    case "dependencies":
      return "Install dependencies and run build or tests after dependency changes.";
    case "deploy":
      return failed
        ? "Fix the deploy failure before claiming the change is live."
        : "Attach successful deploy evidence if this receipt is used for release approval.";
    case "verification":
      return "Run the expected test/build/typecheck/lint commands after the latest edit.";
    case "fix":
      return failed
        ? "Make an actual file edit for the claimed fix, or remove the claim."
        : "Review the edited files and run the repo's normal checks.";
    default:
      return claim.status === "verified" ? null : `Resolve this ${claim.kind} finding before merge.`;
  }
}

function nextActionsFor(analysis: AnalysisResult): string[] {
  const actions = analysis.receipts
    .filter((claim) => claim.status !== "verified")
    .map(actionForClaim)
    .filter((action): action is string => !!action);
  const unique = [...new Set(actions)].slice(0, 4);

  if (unique.length > 0) return unique;
  if (analysis.edits > 0) {
    return [
      "Review the diff normally; AgentReceipt does not replace human code review.",
      "Keep the receipt with the PR so reviewers can inspect the evidence trail.",
    ];
  }
  return [
    "Run AgentReceipt from the repo after a real AI coding session, or pass a transcript file explicitly.",
  ];
}

export function buildReceipt(
  session: ParsedSession,
  analysis: AnalysisResult,
  sc: Score,
  generatedAt: number
): TrustReceipt {
  const decision = decisionFor(analysis, sc);
  const body = {
    sessionId: session.sessionId || "unknown",
    agent: session.agent,
    trust: sc.trust,
    archetype: sc.archetype,
    decision,
    summary: summaryFor(analysis, sc),
    nextActions: nextActionsFor(analysis),
    claims: analysis.receipts,
    ...(session.evidenceNote ? { evidenceNote: session.evidenceNote } : {}),
    stats: {
      toolCalls: analysis.toolCalls,
      edits: analysis.edits,
      verified: analysis.counts.verified,
      contradicted: analysis.counts.contradicted,
      unsupported: analysis.counts.unsupported,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      approxCostUsd: approxCost(session.inputTokens, session.outputTokens),
      durationMs:
        session.firstTs && session.lastTs ? session.lastTs - session.firstTs : null,
    },
    generatedAt,
  };
  const signature = sign(body as unknown as JsonValue);
  return { receiptId: signature.digest.slice(0, 12), body, signature };
}

export function verifyReceipt(r: TrustReceipt): { valid: boolean; reason?: string } {
  return verify(r.body as unknown as JsonValue, r.signature);
}
