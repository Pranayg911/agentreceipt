#!/usr/bin/env node
// agentreceipt — grade your latest AI coding-agent session and print a signed
// Trust Receipt right in the terminal.
//
//   npx agentreceipt              # grade the most recent session for this repo
//   npx agentreceipt --web        # grade and open a web receipt
//   npx agentreceipt --agent codex # force one adapter: claude, codex, cursor
//   npx agentreceipt --ci --min-trust 80 # fail CI below a trust threshold
//   npx agentreceipt --ci --allow-warnings # allow unproven gaps, but still fail contradictions
//   npx agentreceipt --url        # grade and print a web receipt URL
//   npx agentreceipt --all        # grade the most recent session anywhere
//   npx agentreceipt <file.jsonl> # grade a specific transcript
//   npx agentreceipt verify <file.json>   # verify a saved receipt

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  collectProjectContext,
  encodeReceipt,
  gradeSessionFile,
  verifyReceipt,
  type AgentKind,
  type TrustReceipt,
} from "./index.js";
import { latestSession } from "./sessions.js";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const DEFAULT_WEB_URL = process.env.AGENTRECEIPT_WEB_URL ?? "https://agentreceipt.vercel.app";
const WEB_FLAGS = ["--web", "--open"];
const URL_FLAGS = ["--url", "--print-url"];
const AGENTS = new Set(["auto", "claude", "codex", "cursor"]);
const FORMATS = new Set(["text", "json", "markdown"]);
const VALUE_FLAGS = new Set(["--agent", "--format", "--min-trust", "--output"]);
type ReportFormat = "text" | "json" | "markdown";

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
  console.log(
    `  ${B}AGENT RECEIPT${X}  ${D}${s.agent} · ${s.sessionId.slice(0, 8)} · ${r.receiptId}${X}`
  );
  console.log("");
  console.log(`  TRUST  ${scoreColor}${B}${s.trust}${X}/100   ${bar(s.trust)}`);
  console.log(`  ${B}${s.archetype}${X}`);
  console.log(`  ${scoreColor}${B}${s.decision.title}${X}`);
  const gateColor = s.mergeGate.status === "pass" ? G : s.mergeGate.status === "warn" ? Y : R;
  console.log(`  ${gateColor}${B}${s.mergeGate.title}${X} ${D}${s.mergeGate.reason}${X}`);
  console.log(`  ${D}${s.summary}${X}`);
  console.log("");
  console.log(`  ${B}WHAT HAPPENED${X}`);
  s.auditTrail.story.forEach((line) => {
    console.log(`  - ${line}`);
  });
  if (s.auditTrail.commands.length > 0) {
    console.log("");
    console.log(`  ${B}COMMANDS${X}`);
    s.auditTrail.commands.slice(0, 5).forEach((cmd) => {
      const tone = cmd.status === "passed" ? G : cmd.status === "failed" ? R : Y;
      const exit = cmd.exitCode == null ? "" : ` exit ${cmd.exitCode}`;
      console.log(`  ${tone}${cmd.status.toUpperCase()}${X} ${cmd.command}${exit}`);
    });
  }
  console.log("");
  for (const c of s.claims) {
    const icon =
      c.status === "verified" ? `${G}✓${X}` : c.status === "contradicted" ? `${R}✗${X}` : `${Y}~${X}`;
    console.log(`  ${icon} ${c.claim}`);
    console.log(`     ${D}${c.evidence}${X}`);
  }
  if (s.claims.length === 0) {
    console.log(`  ${D}No claims, edits, or verification gaps found to check.${X}`);
  }
  if (s.evidenceNote) {
    console.log(`  ${Y}note${X} ${s.evidenceNote}`);
  }
  if (s.nextActions.length > 0) {
    console.log("");
    console.log(`  ${B}NEXT${X}`);
    s.nextActions.forEach((action, i) => {
      console.log(`  ${i + 1}. ${action}`);
    });
  }
  console.log("");
  const st = s.stats;
  console.log(
    `  ${D}${st.toolCalls} tool calls · ${st.edits} edits · ` +
      `${G}${st.verified} verified${X}${D} · ${Y}${st.unsupported} gaps${X}${D} · ${R}${st.contradicted} failed${X}` +
      `${D} · ~$${st.approxCostUsd}${X}`
  );
  console.log(
    `  ${v.valid ? G + "✓ ed25519 signed & verifiable" : R + "✗ " + v.reason}${X}` +
      `  ${D}key ${r.signature.fingerprint}${X}`
  );
  console.log("");
}

function hasFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)));
}

function valueAfterFlag(args: string[], flags: string[]): string | null {
  const inline = args.find((arg) => flags.some((flag) => arg.startsWith(`${flag}=`)));
  if (inline) return inline.slice(inline.indexOf("=") + 1);
  const i = args.findIndex((arg) => flags.includes(arg));
  if (i < 0) return null;
  const next = args[i + 1];
  return next && !next.startsWith("-") ? next : DEFAULT_WEB_URL;
}

function valueForFlag(args: string[], flag: string): string | null {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const next = args[i + 1];
  return next && !next.startsWith("-") ? next : null;
}

function numberForFlag(args: string[], flag: string): number | null {
  const value = valueForFlag(args, flag);
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    console.error(`${R}${flag} must be a number from 0 to 100.${X}`);
    process.exit(2);
  }
  return n;
}

function formatFromArgs(args: string[]): ReportFormat {
  const value = valueForFlag(args, "--format") ?? "text";
  if (!FORMATS.has(value)) {
    console.error(`${R}Unknown format "${value}". Use text, json, or markdown.${X}`);
    process.exit(2);
  }
  return value as ReportFormat;
}

function agentFromArgs(args: string[]): AgentKind | "auto" {
  const value = valueForFlag(args, "--agent");
  if (!value) return "auto";
  if (!AGENTS.has(value)) {
    console.error(`${R}Unknown agent "${value}". Use auto, claude, codex, or cursor.${X}`);
    process.exit(2);
  }
  return value as AgentKind | "auto";
}

function receiptUrl(r: TrustReceipt, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/${encodeReceipt(r)}`;
}

function statusLabel(status: string): string {
  if (status === "verified") return "PASS";
  if (status === "contradicted") return "FAIL";
  return "GAP";
}

function mergeGatePass(r: TrustReceipt, allowWarnings: boolean): boolean {
  const status = r.body.mergeGate.status;
  return allowWarnings ? status !== "fail" : status === "pass";
}

function markdownEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function markdownReport(
  r: TrustReceipt,
  options: { url?: string; minTrust?: number; passed: boolean }
): string {
  const s = r.body;
  const st = s.stats;
  const v = verifyReceipt(r);
  const verdict = options.passed ? "PASS" : "FAIL";
  const rows = s.claims.length
    ? s.claims
        .map(
          (c) =>
            `| ${statusLabel(c.status)} | ${markdownEscape(c.kind)} | ${markdownEscape(c.claim)} | ${markdownEscape(c.evidence)} |`
        )
        .join("\n")
    : "| PASS | none | No claims, edits, or verification gaps found | No issues detected |";
  const commandRows = s.auditTrail.commands.length
    ? s.auditTrail.commands
        .map(
          (c) =>
            `| ${markdownEscape(c.status)} | ${markdownEscape(c.command)} | ${
              c.exitCode == null ? "" : c.exitCode
            } |`
        )
        .join("\n")
    : "| none | No shell command evidence captured | |";

  return [
    `# AgentReceipt ${verdict}`,
    "",
    `**Trust:** ${s.trust}/100`,
    `**Archetype:** ${s.archetype}`,
    `**Decision:** ${s.decision.title}`,
    `**Merge gate:** ${s.mergeGate.title} (${s.mergeGate.status})`,
    `**Gate reason:** ${s.mergeGate.reason}`,
    `**Summary:** ${s.summary}`,
    `**Agent:** ${s.agent}`,
    `**Receipt:** ${r.receiptId}`,
    `**Signature:** ${v.valid ? "valid" : `invalid (${v.reason})`}`,
    options.minTrust != null ? `**Minimum required:** ${options.minTrust}/100` : null,
    options.url ? `**Signed receipt URL:** ${options.url}` : null,
    s.evidenceNote ? `**Evidence note:** ${s.evidenceNote}` : null,
    "",
    "## What Happened",
    ...s.auditTrail.story.map((line) => `- ${line}`),
    "",
    "## Session Context",
    `**Prompt excerpt:** ${s.auditTrail.promptExcerpt ?? "Not available"}`,
    `**Changed files:** ${
      s.auditTrail.changedFiles.length ? s.auditTrail.changedFiles.join(", ") : "None identified"
    }`,
    `**Evidence source:** ${s.auditTrail.evidenceSource}`,
    `**Privacy:** ${s.auditTrail.privacyNote}`,
    "",
    "## Commands",
    "| Status | Command | Exit |",
    "|---|---|---|",
    commandRows,
    "",
    `**Stats:** ${st.toolCalls} tool calls / ${st.edits} edits / ${st.verified} verified / ${st.unsupported} gaps / ${st.contradicted} failed`,
    "",
    "| Status | Kind | Finding | Evidence |",
    "|---|---|---|---|",
    rows,
    "",
    "## Next Actions",
    ...s.nextActions.map((action) => `- ${action}`),
    "",
    "_AgentReceipt verifies AI-generated work with deterministic transcript, command, git, and package evidence. It is not an LLM judge._",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function jsonReport(
  r: TrustReceipt,
  options: { url?: string; minTrust?: number; passed: boolean }
): string {
  const signature = verifyReceipt(r);
  return JSON.stringify(
    {
      ok: options.passed,
      minTrust: options.minTrust ?? null,
      url: options.url ?? null,
      signature,
      mergeGate: r.body.mergeGate,
      receipt: r,
    },
    null,
    2
  );
}

function openUrl(url: string): boolean {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function positionalTranscriptArg(args: string[]): string | null {
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg) && args[i + 1] && !args[i + 1].startsWith("-")) {
      consumed.add(i + 1);
    }
    if ([...WEB_FLAGS, ...URL_FLAGS].includes(arg) && args[i + 1] && !args[i + 1].startsWith("-")) {
      consumed.add(i + 1);
    }
  }
  return (
    args.find((arg, i) => !consumed.has(i) && !arg.startsWith("-") && /\.(jsonl|json)$/i.test(arg)) ??
    null
  );
}

function persistReceipt(receipt: TrustReceipt): void {
  try {
    const out = `${process.env.HOME}/.agentreceipt/last-receipt.json`;
    fs.mkdirSync(`${process.env.HOME}/.agentreceipt`, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
  } catch {
    /* ignore */
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const format = formatFromArgs(args);
  const ci = args.includes("--ci");
  const minTrust = numberForFlag(args, "--min-trust") ?? (ci ? 80 : null);
  const allowWarnings = args.includes("--allow-warnings") || args.includes("--score-only");
  const output = valueForFlag(args, "--output");
  const agent = agentFromArgs(args);

  if (args[0] === "verify" && args[1]) {
    const r = JSON.parse(fs.readFileSync(args[1], "utf8")) as TrustReceipt;
    const v = verifyReceipt(r);
    console.log(v.valid ? `${G}✓ valid${X}` : `${R}✗ ${v.reason}${X}`);
    process.exit(v.valid ? 0 : 1);
  }

  let file: string | null = null;
  const fileArg = positionalTranscriptArg(args);
  if (fileArg) {
    file = fileArg;
  } else {
    const sess = latestSession({
      agent,
      scopeToCwd: !args.includes("--all"),
    });
    if (!sess) {
      console.error(
        `${R}No supported AI agent sessions found.${X}\n` +
          `Run this in a repo where you've used Claude Code, Codex, or Cursor, pass --all, or pass a transcript path.`
      );
      process.exit(2);
    }
    file = sess.path;
    if (format === "text") console.log(`${D}grading ${sess.agent} session: ${sess.path}${X}`);
  }

  const project = collectProjectContext();
  const relTranscript = path.relative(process.cwd(), file);
  if (!relTranscript.startsWith("..") && !path.isAbsolute(relTranscript)) {
    project.changedFiles = project.changedFiles?.filter((changed) => changed !== relTranscript);
    if (project.changedFiles?.length === 0 && project.source === "git") project.source = "none";
  }

  const receipt = gradeSessionFile(file, Date.now(), {
    agent: agent === "auto" ? "auto" : agent,
    project,
  });
  const shouldOpenWeb = hasFlag(args, WEB_FLAGS);
  const shouldPrintUrl = shouldOpenWeb || hasFlag(args, URL_FLAGS);
  const wantsReportUrl = shouldPrintUrl || format !== "text" || ci;
  const baseUrl = valueAfterFlag(args, [...WEB_FLAGS, ...URL_FLAGS]) ?? DEFAULT_WEB_URL;
  const url = wantsReportUrl ? receiptUrl(receipt, baseUrl) : undefined;
  const signature = verifyReceipt(receipt);
  const thresholdPassed = minTrust == null || receipt.body.trust >= minTrust;
  const shouldGateDecision = ci || minTrust != null;
  const gatePassed = !shouldGateDecision || mergeGatePass(receipt, allowWarnings);
  const passed = signature.valid && thresholdPassed && gatePassed;

  if (format === "text") {
    render(receipt);
    if (shouldPrintUrl && url) {
      console.log(`  ${D}web receipt:${X} ${url}`);
      if (shouldOpenWeb) {
        console.log(
          openUrl(url)
            ? `  ${G}opened in browser${X}`
            : `  ${Y}could not open browser; paste the URL above${X}`
        );
      }
      console.log("");
    }

    if (minTrust != null) {
      const color = passed ? G : R;
      console.log(
        `  ${color}${passed ? "PASS" : "FAIL"}${X} trust ${receipt.body.trust}/100 ` +
          `${thresholdPassed ? ">=" : "<"} required ${minTrust}/100`
      );
      console.log(
        `  ${gatePassed ? G : R}${gatePassed ? "PASS" : "FAIL"}${X} ` +
          `${receipt.body.mergeGate.title}: ${receipt.body.mergeGate.reason}`
      );
      if (allowWarnings) {
        console.log(`  ${Y}allow-warnings enabled: unproven gaps do not fail this gate${X}`);
      }
      console.log("");
    }

    if (output) {
      const report = markdownReport(receipt, { url, minTrust: minTrust ?? undefined, passed });
      fs.writeFileSync(output, report.endsWith("\n") ? report : `${report}\n`);
      console.log(`  ${D}wrote report:${X} ${output}`);
    }
  } else {
    const report =
      format === "json"
        ? jsonReport(receipt, { url, minTrust: minTrust ?? undefined, passed })
        : markdownReport(receipt, { url, minTrust: minTrust ?? undefined, passed });

    if (output) {
      fs.writeFileSync(output, report.endsWith("\n") ? report : `${report}\n`);
    } else {
      console.log(report);
    }
  }

  // Persist the receipt next to a local ledger so it can be verified later.
  persistReceipt(receipt);

  if (ci || minTrust != null) process.exit(passed ? 0 : 1);
}

main();
