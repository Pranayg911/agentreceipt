// Parser for Claude Code session transcripts (~/.claude/projects/<proj>/<id>.jsonl).
//
// Verified format (one JSON object per line):
//   { type: "user" | "assistant" | ..., message: { role, content: Block[], usage? } }
// where a Block is one of:
//   { type: "text", text }
//   { type: "thinking" | "redacted_thinking", ... }            (ignored for claims)
//   { type: "tool_use", id, name, input: {...} }               (assistant action)
//   { type: "tool_result", tool_use_id, is_error, content }    (in a user turn)
// Bash failures put "Exit code N" at the top of tool_result.content.
//
// We flatten this into: assistant TEXT (where claims live) + a list of TOOL
// CALLS each joined to its RESULT, with success/failure + touched files.

import fs from "node:fs";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Joined from the matching tool_result. */
  ok: boolean; // !is_error AND no "Exit code <non-zero>"
  exitCode: number | null;
  resultText: string;
  /** For Edit/Write/NotebookEdit: the file path touched. */
  touchedFile?: string;
}

export interface ParsedSession {
  sessionId: string;
  /** Concatenated assistant text (claims live here). */
  assistantText: string;
  /** Per-assistant-message text segments (for locating a claim near its tools). */
  assistantSegments: string[];
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  firstTs: number | null;
  lastTs: number | null;
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text ?? "")
          : typeof b === "string"
            ? b
            : ""
      )
      .join("\n");
  }
  return "";
}

function exitCodeOf(text: string): number | null {
  const m = text.match(/^\s*Exit code (\d+)/m);
  return m ? Number(m[1]) : null;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export function parseSessionText(raw: string): ParsedSession {
  const lines = raw.split("\n").filter((l) => l.trim());
  const toolUses = new Map<string, ToolCall>();
  const results = new Map<string, { ok: boolean; exitCode: number | null; text: string }>();
  const segments: string[] = [];
  let sessionId = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionId && typeof o.sessionId === "string") sessionId = o.sessionId;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }

    const msg = o.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      inputTokens += Number(usage.input_tokens ?? 0) || 0;
      outputTokens += Number(usage.output_tokens ?? 0) || 0;
    }
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const bt = b.type;
      if (bt === "text" && o.type === "assistant") {
        segments.push(String(b.text ?? ""));
      } else if (bt === "tool_use") {
        const input = (b.input as Record<string, unknown>) ?? {};
        const name = String(b.name ?? "");
        const tc: ToolCall = {
          id: String(b.id ?? ""),
          name,
          input,
          ok: true,
          exitCode: null,
          resultText: "",
          touchedFile: EDIT_TOOLS.has(name)
            ? (typeof input.file_path === "string" ? input.file_path : undefined)
            : undefined,
        };
        toolUses.set(tc.id, tc);
      } else if (bt === "tool_result") {
        const text = asText(b.content);
        const ec = exitCodeOf(text);
        results.set(String(b.tool_use_id ?? ""), {
          ok: b.is_error !== true && (ec === null || ec === 0),
          exitCode: ec,
          text,
        });
      }
    }
  }

  // Join results into their tool calls.
  for (const [id, tc] of toolUses) {
    const r = results.get(id);
    if (r) {
      tc.ok = r.ok;
      tc.exitCode = r.exitCode;
      tc.resultText = r.text.slice(0, 4000);
    } else {
      // No result recorded (e.g. still pending / truncated) — treat as unknown,
      // not a success, so we never credit an unobserved action.
      tc.ok = false;
      tc.resultText = "(no tool result recorded)";
    }
  }

  return {
    sessionId,
    assistantText: segments.join("\n\n"),
    assistantSegments: segments,
    toolCalls: [...toolUses.values()],
    inputTokens,
    outputTokens,
    firstTs,
    lastTs,
  };
}

export function parseSessionFile(file: string): ParsedSession {
  return parseSessionText(fs.readFileSync(file, "utf8"));
}
