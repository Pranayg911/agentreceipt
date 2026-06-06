// Build + sign the Trust Receipt — the shareable, verifiable artifact.

import { sign, verify, type SignaturePayload } from "./signer.js";
import type { JsonValue } from "./stable-json.js";
import type {
  AgentReceiptPolicy,
  AnalysisResult,
  CiCheckEvidence,
  ClaimReceipt,
  CommandEvidence,
} from "./analyze.js";
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
    mergeGate: {
      status: "pass" | "warn" | "fail";
      title: string;
      reason: string;
      blocking: boolean;
    };
    summary: string;
    nextActions: string[];
    policy?: AgentReceiptPolicy;
    auditTrail: {
      promptExcerpt: string | null;
      changedFiles: string[];
      evidenceSource: "git" | "transcript" | "none";
      commands: CommandEvidence[];
      ciChecks: CiCheckEvidence[];
      story: string[];
      privacyNote: string;
    };
    claims: ClaimReceipt[];
    evidenceNote?: string;
    stats: {
      toolCalls: number;
      edits: number;
      verified: number;
      contradicted: number;
      unsupported: number;
      policyViolations: number;
      ciChecks: number;
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
  if (analysis.policyViolations > 0) {
    return `Trust ${sc.trust}/100 because ${plural(
      analysis.policyViolations,
      "team policy requirement"
    )} did not pass. Fix the required gate before merge.`;
  }
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

function mergeGateFor(
  decision: TrustReceipt["body"]["decision"],
  analysis: AnalysisResult
): TrustReceipt["body"]["mergeGate"] {
  if (analysis.policyViolations > 0) {
    return {
      status: "fail",
      title: "Team policy gate failed",
      reason: `${plural(
        analysis.policyViolations,
        "required policy check"
      )} must pass before this AI-code change can merge.`,
      blocking: true,
    };
  }
  if (decision.label === "ready") {
    return {
      status: "pass",
      title: "Merge gate passed",
      reason: "No failed or unproven findings were detected in the signed evidence.",
      blocking: false,
    };
  }
  if (decision.label === "verify_first") {
    return {
      status: "warn",
      title: "Merge gate blocked by missing proof",
      reason: `${plural(
        analysis.counts.unsupported,
        "finding"
      )} still need evidence before this should pass an AI-code merge gate.`,
      blocking: true,
    };
  }
  if (decision.label === "do_not_merge") {
    return {
      status: "fail",
      title: "Merge gate failed",
      reason: `${plural(
        analysis.counts.contradicted,
        "failed or contradicted finding"
      )} must be fixed before merge.`,
      blocking: true,
    };
  }
  return {
    status: "fail",
    title: "Merge gate failed",
    reason: "No code-work evidence was available to verify.",
    blocking: true,
  };
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
    case "ci":
      return failed
        ? "Fix the failed external CI check, then regenerate or rerun AgentReceipt."
        : "Wait for external CI to finish successfully, then rerun AgentReceipt.";
    case "policy":
      return failed
        ? "Fix the required team policy gate, then rerun AgentReceipt."
        : "Run the required team policy check or attach matching CI evidence.";
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

function listPreview(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  const shown = items.slice(0, 4).join(", ");
  return `${shown}${items.length > 4 ? `, and ${items.length - 4} more` : ""}`;
}

function storyFor(
  analysis: AnalysisResult,
  decision: TrustReceipt["body"]["decision"]
): string[] {
  const commands = analysis.commands;
  const failed = commands.filter((c) => c.status === "failed").length;
  const unknown = commands.filter((c) => c.status === "unknown").length;
  const passed = commands.filter((c) => c.status === "passed").length;
  const ciPassed = analysis.ciChecks.filter(
    (c) => c.status === "completed" && c.conclusion === "success"
  ).length;
  const ciFailed = analysis.ciChecks.filter((c) =>
    ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(
      c.conclusion ?? ""
    )
  ).length;
  const topIssue = analysis.receipts.find((r) => r.status !== "verified");

  return [
    analysis.promptExcerpt
      ? `User asked: "${analysis.promptExcerpt}"`
      : "No user prompt text was available in the parsed session artifact.",
    analysis.changedFiles.length > 0
      ? `Files changed: ${listPreview(analysis.changedFiles, "none")}.`
      : analysis.edits > 0
        ? `${analysis.edits} edit tool call(s) were recorded, but no file paths were available.`
        : "No file edits were identified in the session.",
    commands.length > 0
      ? `Commands observed: ${commands.length} total (${passed} passed, ${failed} failed, ${unknown} unknown).`
      : "No shell command evidence was captured.",
    analysis.ciChecks.length > 0
      ? `External CI observed: ${analysis.ciChecks.length} check(s) (${ciPassed} passed, ${ciFailed} failed).`
      : "No external CI check evidence was attached.",
    topIssue
      ? `Top issue: ${topIssue.claim} - ${topIssue.evidence}`
      : "No failed or unproven findings were detected.",
    `Decision: ${decision.title}.`,
  ];
}

export function buildReceipt(
  session: ParsedSession,
  analysis: AnalysisResult,
  sc: Score,
  generatedAt: number
): TrustReceipt {
  const decision = decisionFor(analysis, sc);
  const mergeGate = mergeGateFor(decision, analysis);
  const body = {
    sessionId: session.sessionId || "unknown",
    agent: session.agent,
    trust: sc.trust,
    archetype: sc.archetype,
    decision,
    mergeGate,
    summary: summaryFor(analysis, sc),
    nextActions: nextActionsFor(analysis),
    ...(analysis.policy ? { policy: analysis.policy } : {}),
    auditTrail: {
      promptExcerpt: analysis.promptExcerpt,
      changedFiles: analysis.changedFiles,
      evidenceSource: analysis.evidenceSource,
      commands: analysis.commands,
      ciChecks: analysis.ciChecks,
      story: storyFor(analysis, decision),
      privacyNote:
        "Prompt, command, and CI text is redacted and length-capped. The full raw transcript is not embedded in the receipt.",
    },
    claims: analysis.receipts,
    ...(session.evidenceNote ? { evidenceNote: session.evidenceNote } : {}),
    stats: {
      toolCalls: analysis.toolCalls,
      edits: analysis.edits,
      verified: analysis.counts.verified,
      contradicted: analysis.counts.contradicted,
      unsupported: analysis.counts.unsupported,
      policyViolations: analysis.policyViolations,
      ciChecks: analysis.ciChecks.length,
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
