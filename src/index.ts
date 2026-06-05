// agentreceipt — the signed proof your AI coding agent actually did the work.
//
//   import { gradeSessionFile } from "agentreceipt";
//   const receipt = gradeSessionFile("~/.claude/projects/.../session.jsonl");
//   // receipt.body.trust, receipt.body.archetype, receipt.body.claims[]

import { parseSessionFile, parseSessionText } from "./parse.js";
import { analyze, type ProjectAuditContext } from "./analyze.js";
import { score } from "./score.js";
import { buildReceipt, verifyReceipt, type TrustReceipt } from "./receipt.js";
import type { AgentKind } from "./sessions.js";

export interface GradeOptions {
  project?: ProjectAuditContext;
  agent?: AgentKind | "auto";
}

export function gradeSessionText(
  raw: string,
  now = Date.now(),
  options: GradeOptions = {}
): TrustReceipt {
  const session = parseSessionText(raw, options.agent ?? "auto");
  const analysis = analyze(session, options);
  return buildReceipt(session, analysis, score(analysis), now);
}

export function gradeSessionFile(
  file: string,
  now = Date.now(),
  options: GradeOptions = {}
): TrustReceipt {
  const session = parseSessionFile(file, options.agent ?? "auto");
  const analysis = analyze(session, options);
  return buildReceipt(session, analysis, score(analysis), now);
}

export { verifyReceipt };
export type { TrustReceipt };
export { parseSessionFile, parseSessionText } from "./parse.js";
export { analyze, type AnalysisResult, type ClaimReceipt } from "./analyze.js";
export { score, type Score } from "./score.js";
export { latestSession, listSessions, type AgentKind, type SessionFile } from "./sessions.js";
export { sign, verify, type SignaturePayload } from "./signer.js";
export { encodeReceipt } from "./token.js";
export { collectProjectContext } from "./project.js";
export type { ProjectAuditContext } from "./analyze.js";
