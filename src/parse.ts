// Normalize different agent transcript formats into one evidence model.
//
// Claude Code: ~/.claude/projects/<proj>/<id>.jsonl
// Codex:      ~/.codex/sessions/<date>/rollout-*.jsonl
// Cursor:     checkpoint metadata (limited; no stable full transcript yet)

import fs from "node:fs";
import path from "node:path";
import { codexThreadForPath, type AgentKind } from "./sessions.js";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Joined from the matching tool result. */
  ok: boolean;
  exitCode: number | null;
  resultText: string;
  /** For Edit/Write/NotebookEdit/MultiEdit/apply_patch: the file path touched. */
  touchedFile?: string;
}

export interface ParsedSession {
  sessionId: string;
  agent: AgentKind | "unknown";
  /** Concatenated assistant text (claims live here). */
  assistantText: string;
  /** Per-assistant-message text segments (for locating a claim near its tools). */
  assistantSegments: string[];
  /** User request text excerpts, used for signed context without storing full transcripts. */
  userSegments: string[];
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  firstTs: number | null;
  lastTs: number | null;
  cwd?: string;
  /** Honest disclosure for adapters that expose less than full transcript data. */
  evidenceNote?: string;
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
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return "";
}

function exitCodeOf(text: string): number | null {
  const m = text.match(/(?:Exit code|Process exited with code)\s+(-?\d+)/i);
  return m ? Number(m[1]) : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function joinResults(toolUses: Map<string, ToolCall>, results: Map<string, { ok: boolean; exitCode: number | null; text: string }>) {
  for (const [id, tc] of toolUses) {
    const r = results.get(id);
    if (r) {
      tc.ok = r.ok;
      tc.exitCode = r.exitCode;
      tc.resultText = r.text.slice(0, 4000);
    } else {
      tc.ok = false;
      tc.resultText = "(no tool result recorded)";
    }
  }
}

export function parseClaudeSessionText(raw: string): ParsedSession {
  const lines = raw.split("\n").filter((l) => l.trim());
  const toolUses = new Map<string, ToolCall>();
  const results = new Map<string, { ok: boolean; exitCode: number | null; text: string }>();
  const segments: string[] = [];
  const userSegments: string[] = [];
  let sessionId = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const line of lines) {
    const o = parseJsonLine(line);
    if (!o) continue;
    if (!sessionId && typeof o.sessionId === "string") sessionId = o.sessionId;
    const ts = timestampMs(o.timestamp);
    if (ts != null) {
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
    if (typeof content === "string" && o.type === "user") {
      userSegments.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const bt = b.type;
      if (bt === "text" && o.type === "assistant") {
        segments.push(String(b.text ?? ""));
      } else if (bt === "text" && o.type === "user") {
        userSegments.push(String(b.text ?? ""));
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

  joinResults(toolUses, results);

  return {
    sessionId,
    agent: "claude",
    assistantText: segments.join("\n\n"),
    assistantSegments: segments,
    userSegments,
    toolCalls: [...toolUses.values()],
    inputTokens,
    outputTokens,
    firstTs,
    lastTs,
  };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") {
    const out = raw as Record<string, unknown>;
    if (typeof out.cmd === "string" && typeof out.command !== "string") out.command = out.cmd;
    return out;
  }
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    const out = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    if (typeof out.cmd === "string" && typeof out.command !== "string") out.command = out.cmd;
    return out;
  } catch {
    return { input: raw };
  }
}

function normalizeCodexToolName(name: string): string {
  if (name === "exec_command" || name.endsWith(".exec_command")) return "Bash";
  if (name === "write_stdin" || name.endsWith(".write_stdin")) return "Bash";
  if (name === "apply_patch" || name.endsWith(".apply_patch")) return "Edit";
  if (name === "view_image" || name.endsWith(".view_image")) return "View";
  return name;
}

function codexTouchedFile(name: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.cmd === "string") {
    const m = input.cmd.match(/(?:^|\s)(?:>|>>|touch|cat\s+>\s*)\s*(['"]?)([^'"\s]+)\1/);
    if (m) return m[2];
  }
  if (name === "Edit" && typeof input.input === "string") {
    const m = input.input.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/m);
    if (m) return m[1].trim();
  }
  return undefined;
}

function contentBlocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function patchChangedFiles(changes: unknown): string[] {
  if (!changes || typeof changes !== "object") return [];
  return Object.keys(changes as Record<string, unknown>);
}

export function parseCodexSessionText(raw: string, filePath?: string): ParsedSession {
  const toolUses = new Map<string, ToolCall>();
  const results = new Map<string, { ok: boolean; exitCode: number | null; text: string }>();
  const segments: string[] = [];
  const userSegments: string[] = [];
  let sessionId = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let cwd: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const o = parseJsonLine(line);
    if (!o) continue;
    const payload = (o.payload && typeof o.payload === "object" ? o.payload : {}) as Record<string, unknown>;
    const ts = timestampMs(o.timestamp ?? payload.timestamp ?? payload.started_at ?? payload.completed_at);
    if (ts != null) {
      firstTs ??= ts;
      lastTs = ts;
    }

    if (o.type === "session_meta") {
      sessionId = String(payload.id ?? sessionId);
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      continue;
    }
    if (o.type === "turn_context") {
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      continue;
    }
    if (o.type === "event_msg") {
      if (payload.type === "agent_message" && typeof payload.message === "string") {
        segments.push(payload.message);
      }
      if (payload.type === "user_message" && typeof payload.message === "string") {
        userSegments.push(payload.message);
      }
      if (payload.type === "user_message" && !sessionId && typeof payload.client_id === "string") {
        sessionId = payload.client_id;
      }
      if (payload.type === "token_count") {
        const info = payload.info as Record<string, unknown> | undefined;
        const total = info?.total_token_usage as Record<string, unknown> | undefined;
        inputTokens = Number(total?.input_tokens ?? inputTokens) || inputTokens;
        outputTokens = Number(total?.output_tokens ?? outputTokens) || outputTokens;
      }
      if (payload.type === "patch_apply_end") {
        const id = String(payload.call_id ?? "");
        const files = patchChangedFiles(payload.changes);
        const text = [String(payload.stdout ?? ""), String(payload.stderr ?? "")]
          .filter(Boolean)
          .join("\n");
        if (id) {
          results.set(id, {
            ok: payload.success === true || payload.status === "success",
            exitCode: payload.success === false ? 1 : 0,
            text: text || String(payload.status ?? ""),
          });
          const tc = toolUses.get(id);
          if (tc && files[0]) tc.touchedFile = files[0];
        }
      }
      continue;
    }
    if (o.type !== "response_item") continue;

    if (payload.type === "message" && payload.role === "assistant") {
      const text = contentBlocksText(payload.content);
      if (text) segments.push(text);
    } else if (payload.type === "message" && payload.role === "user") {
      const text = contentBlocksText(payload.content);
      if (text) userSegments.push(text);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const rawName = String(payload.name ?? "");
      const name = normalizeCodexToolName(rawName);
      const input = parseArgs(payload.arguments ?? payload.input);
      const id = String(payload.call_id ?? payload.id ?? "");
      if (!id) continue;
      const tc: ToolCall = {
        id,
        name,
        input,
        ok: true,
        exitCode: null,
        resultText: "",
        touchedFile: codexTouchedFile(name, input),
      };
      toolUses.set(id, tc);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const text = asText(payload.output);
      const ec = exitCodeOf(text);
      results.set(String(payload.call_id ?? ""), {
        ok: ec === null || ec === 0,
        exitCode: ec,
        text,
      });
    }
  }

  joinResults(toolUses, results);
  const thread = filePath ? codexThreadForPath(filePath) : {};

  return {
    sessionId: sessionId || (filePath ? path.basename(filePath, ".jsonl") : "codex-session"),
    agent: "codex",
    assistantText: segments.join("\n\n"),
    assistantSegments: segments,
    userSegments,
    toolCalls: [...toolUses.values()],
    inputTokens,
    outputTokens,
    firstTs,
    lastTs,
    cwd: cwd ?? thread.cwd,
  };
}

export function parseCursorCheckpointText(raw: string, filePath?: string): ParsedSession {
  const parsed = JSON.parse(raw) as {
    agentRequestId?: string;
    requestFiles?: Array<{ fsPath?: string }>;
    startTrackingDateUnixMilliseconds?: number;
  };
  const files = (parsed.requestFiles ?? []).map((f) => f.fsPath).filter((f): f is string => !!f);
  const toolCalls = files.map((f, i): ToolCall => ({
    id: `cursor-file-${i}`,
    name: "Edit",
    input: { file_path: f },
    ok: false,
    exitCode: null,
    resultText: "Cursor checkpoint metadata only; full transcript not available.",
    touchedFile: f,
  }));
  const ts = timestampMs(parsed.startTrackingDateUnixMilliseconds);
  return {
    sessionId: parsed.agentRequestId || (filePath ? path.basename(path.dirname(filePath)) : "cursor-session"),
    agent: "cursor",
    assistantText:
      "Cursor checkpoint detected. Full Cursor chat/tool transcript was not available, so AgentReceipt audited changed-file evidence only.",
    assistantSegments: [],
    userSegments: [],
    toolCalls,
    inputTokens: 0,
    outputTokens: 0,
    firstTs: ts,
    lastTs: ts,
    evidenceNote:
      "Cursor support is limited to checkpoint metadata until a stable Cursor transcript source is available.",
  };
}

function detectFormat(raw: string, filePath?: string): AgentKind {
  if (filePath?.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) return "codex";
  if (filePath?.endsWith("metadata.json") && raw.includes("agentRequestId") && raw.includes("requestFiles")) {
    return "cursor";
  }
  const first = raw.split("\n").find((l) => l.trim());
  const parsed = first ? parseJsonLine(first) : null;
  if (parsed?.agentRequestId && Array.isArray(parsed.requestFiles)) {
    return "cursor";
  }
  if (parsed?.type === "session_meta" || parsed?.type === "response_item" || parsed?.type === "event_msg") {
    return "codex";
  }
  return "claude";
}

export function parseSessionText(raw: string, agent: AgentKind | "auto" = "auto"): ParsedSession {
  const detected = agent === "auto" ? detectFormat(raw) : agent;
  if (detected === "codex") return parseCodexSessionText(raw);
  if (detected === "cursor") return parseCursorCheckpointText(raw);
  return parseClaudeSessionText(raw);
}

export function parseSessionFile(file: string, agent: AgentKind | "auto" = "auto"): ParsedSession {
  const raw = fs.readFileSync(file, "utf8");
  const detected = agent === "auto" ? detectFormat(raw, file) : agent;
  if (detected === "codex") return parseCodexSessionText(raw, file);
  if (detected === "cursor") return parseCursorCheckpointText(raw, file);
  return parseClaudeSessionText(raw);
}
