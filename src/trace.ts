import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { randomUUID } from "crypto";

export type TraceEventType =
  | "run_start"
  | "run_end"
  | "model_call_start"
  | "model_call_end"
  | "tool_call_start"
  | "tool_call_end"
  | "permission_check"
  | "hook_start"
  | "hook_end"
  | "memory_recall"
  | "subagent_start"
  | "subagent_end"
  | "error"
  | "cost_update";

export interface TraceEvent {
  ts: string;
  runId: string;
  seq: number;
  type: TraceEventType;
  [key: string]: any;
}

export interface TraceRecorderOptions {
  filePath?: string;
  runId?: string;
  sessionId?: string;
  parentRunId?: string;
}

const MAX_STRING_CHARS = 1600;
const MAX_RESULT_CHARS = 2400;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_KEYS = 50;
const SECRET_KEY_RE = /(api[_-]?key|authorization|bearer|token|secret|password|credential)/i;

export class TraceRecorder {
  readonly runId: string;
  readonly filePath: string;
  private seq = 0;
  private sessionId?: string;
  private parentRunId?: string;

  constructor(options: TraceRecorderOptions = {}) {
    this.runId = options.runId || randomUUID().slice(0, 8);
    this.filePath = resolve(options.filePath || defaultTracePath(this.runId));
    this.sessionId = options.sessionId;
    this.parentRunId = options.parentRunId;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  record(type: TraceEventType, fields: Record<string, any> = {}): void {
    const event: TraceEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      seq: ++this.seq,
      type,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.parentRunId ? { parentRunId: this.parentRunId } : {}),
      ...sanitizeValue(fields),
    };
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf-8");
  }

  error(stage: string, error: unknown, fields: Record<string, any> = {}): void {
    this.record("error", {
      stage,
      error: formatError(error),
      ...fields,
    });
  }
}

export function defaultTracePath(runId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(process.cwd(), ".mini-claude", "traces", `${stamp}-${runId}.jsonl`);
}

export function readTraceEvents(filePath: string): TraceEvent[] {
  const text = readFileSync(filePath, "utf-8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

export function summarizeToolInput(toolName: string, input: Record<string, any>): Record<string, any> {
  const copy: Record<string, any> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (SECRET_KEY_RE.test(key)) {
      copy[key] = "[redacted]";
      continue;
    }
    if ((toolName === "write_file" || toolName === "edit_file") && typeof value === "string") {
      if (key === "content" || key === "old_string" || key === "new_string") {
        copy[key] = summarizeText(value, MAX_STRING_CHARS);
        copy[`${key}Bytes`] = Buffer.byteLength(value);
        continue;
      }
    }
    copy[key] = sanitizeValue(value);
  }
  return copy;
}

export function summarizeResult(result: string): Record<string, any> {
  return {
    ok: !result.startsWith("Error"),
    bytes: Buffer.byteLength(result),
    preview: summarizeText(result, MAX_RESULT_CHARS),
  };
}

export function summarizeText(text: string, maxChars = MAX_STRING_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated ${text.length - maxChars} chars ...]`;
}

export function formatError(error: unknown): Record<string, any> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ? summarizeText(error.stack, MAX_RESULT_CHARS) : undefined,
    };
  }
  return { message: String(error) };
}

function sanitizeValue(value: any, depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return summarizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (depth >= 4) return "[max-depth]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items ...]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const out: Record<string, any> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, nested] of entries) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : sanitizeValue(nested, depth + 1);
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > MAX_OBJECT_KEYS) {
      out.__truncatedKeys = totalKeys - MAX_OBJECT_KEYS;
    }
    return out;
  }

  return String(value);
}
