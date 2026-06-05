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

export function buildReceipt(
  session: ParsedSession,
  analysis: AnalysisResult,
  sc: Score,
  generatedAt: number
): TrustReceipt {
  const body = {
    sessionId: session.sessionId || "unknown",
    agent: session.agent,
    trust: sc.trust,
    archetype: sc.archetype,
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
