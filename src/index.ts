// agentreceipt — the signed proof your AI coding agent actually did the work.
//
//   import { gradeSessionFile } from "agentreceipt";
//   const receipt = gradeSessionFile("~/.claude/projects/.../session.jsonl");
//   // receipt.body.trust, receipt.body.archetype, receipt.body.claims[]

import { parseSessionFile, parseSessionText } from "./parse.js";
import { analyze } from "./analyze.js";
import { score } from "./score.js";
import { buildReceipt, verifyReceipt, type TrustReceipt } from "./receipt.js";

export function gradeSessionText(raw: string, now = Date.now()): TrustReceipt {
  const session = parseSessionText(raw);
  const analysis = analyze(session);
  return buildReceipt(session, analysis, score(analysis), now);
}

export function gradeSessionFile(file: string, now = Date.now()): TrustReceipt {
  const session = parseSessionFile(file);
  const analysis = analyze(session);
  return buildReceipt(session, analysis, score(analysis), now);
}

export { verifyReceipt };
export type { TrustReceipt };
export { parseSessionFile, parseSessionText } from "./parse.js";
export { analyze, type AnalysisResult, type ClaimReceipt } from "./analyze.js";
export { score, type Score } from "./score.js";
export { latestSession, listSessions } from "./sessions.js";
export { sign, verify, type SignaturePayload } from "./signer.js";
export { encodeReceipt } from "./token.js";
