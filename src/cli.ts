#!/usr/bin/env node
// agentreceipt — grade your latest AI coding-agent session and print a signed
// Trust Receipt right in the terminal.
//
//   npx agentreceipt              # grade the most recent session for this repo
//   npx agentreceipt --all        # grade the most recent session anywhere
//   npx agentreceipt <file.jsonl> # grade a specific transcript
//   npx agentreceipt verify <file.json>   # verify a saved receipt

import fs from "node:fs";
import { gradeSessionFile, verifyReceipt, type TrustReceipt } from "./index.js";
import { latestSession } from "./sessions.js";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

function bar(score: number): string {
  const n = Math.round(score / 5);
  const color = score >= 80 ? G : score >= 55 ? Y : R;
  return color + "█".repeat(n) + D + "░".repeat(20 - n) + X;
}

function render(r: TrustReceipt): void {
  const s = r.body;
  const v = verifyReceipt(r);
  const scoreColor = s.trust >= 80 ? G : s.trust >= 55 ? Y : R;
  console.log("");
  console.log(`  ${B}AGENT RECEIPT${X}  ${D}${s.sessionId.slice(0, 8)} · ${r.receiptId}${X}`);
  console.log("");
  console.log(`  TRUST  ${scoreColor}${B}${s.trust}${X}/100   ${bar(s.trust)}`);
  console.log(`  ${B}${s.archetype}${X}`);
  console.log("");
  for (const c of s.claims) {
    const icon =
      c.status === "verified" ? `${G}✓${X}` : c.status === "contradicted" ? `${R}✗${X}` : `${Y}~${X}`;
    console.log(`  ${icon} ${c.claim}`);
    console.log(`     ${D}${c.evidence}${X}`);
  }
  if (s.claims.length === 0) {
    console.log(`  ${D}No success claims found to check.${X}`);
  }
  console.log("");
  const st = s.stats;
  console.log(
    `  ${D}${st.toolCalls} tool calls · ${st.edits} edits · ` +
      `${G}${st.verified} verified${X}${D} · ${Y}${st.unsupported} unproven${X}${D} · ${R}${st.contradicted} contradicted${X}` +
      `${D} · ~$${st.approxCostUsd}${X}`
  );
  console.log(
    `  ${v.valid ? G + "✓ ed25519 signed & verifiable" : R + "✗ " + v.reason}${X}` +
      `  ${D}key ${r.signature.fingerprint}${X}`
  );
  console.log(`  ${D}share:  verify.agentreceipt.dev/${r.receiptId}  (coming) — receipt saved locally${X}`);
  console.log("");
}

function main(): void {
  const args = process.argv.slice(2);

  if (args[0] === "verify" && args[1]) {
    const r = JSON.parse(fs.readFileSync(args[1], "utf8")) as TrustReceipt;
    const v = verifyReceipt(r);
    console.log(v.valid ? `${G}✓ valid${X}` : `${R}✗ ${v.reason}${X}`);
    process.exit(v.valid ? 0 : 1);
  }

  let file: string | null = null;
  if (args[0] && args[0].endsWith(".jsonl")) {
    file = args[0];
  } else {
    const sess = latestSession(!args.includes("--all"));
    if (!sess) {
      console.error(
        `${R}No Claude Code sessions found in ~/.claude/projects.${X}\n` +
          `Run this in a repo where you've used Claude Code, or pass a .jsonl path.`
      );
      process.exit(2);
    }
    file = sess.path;
    console.log(`${D}grading ${sess.path}${X}`);
  }

  const receipt = gradeSessionFile(file);
  render(receipt);

  // Persist the receipt next to a local ledger so it can be verified later.
  try {
    const out = `${process.env.HOME}/.agentreceipt/last-receipt.json`;
    fs.mkdirSync(`${process.env.HOME}/.agentreceipt`, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
  } catch {
    /* ignore */
  }
}

main();
