import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TraceRecorder } from "./trace.js";
import { formatError, summarizeText, summarizeToolInput, summarizeResult } from "./trace.js";

export type HookEventName = "PreToolUse" | "PostToolUse";

export interface HookEntry {
  matcher: string;
  command: string;
  timeoutMs?: number;
}

export interface HookPayload {
  event: HookEventName;
  tool: string;
  input: Record<string, any>;
  runId?: string;
  cwd: string;
  permission?: Record<string, any>;
  result?: Record<string, any>;
}

export interface HookDecision {
  action: "allow" | "deny";
  reason?: string;
}

interface HookConfig {
  PreToolUse: HookEntry[];
  PostToolUse: HookEntry[];
}

interface HookExecution {
  hook: HookEntry;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  parsed?: any;
  error?: unknown;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class HookRunner {
  private config: HookConfig;

  constructor(config: HookConfig = loadHookConfig()) {
    this.config = config;
  }

  hasHooks(event: HookEventName, tool: string): boolean {
    return this.matching(event, tool).length > 0;
  }

  async runPreToolUse(payload: HookPayload, trace?: TraceRecorder): Promise<HookDecision> {
    for (const hook of this.matching("PreToolUse", payload.tool)) {
      trace?.record("hook_start", {
        event: "PreToolUse",
        tool: payload.tool,
        matcher: hook.matcher,
        command: hook.command,
      });

      const result = await executeHook(hook, payload);
      const decision = interpretPreHookResult(result);
      trace?.record("hook_end", hookTraceFields("PreToolUse", payload.tool, result, decision));

      if (decision.action === "deny") {
        return decision;
      }
    }
    return { action: "allow" };
  }

  async runPostToolUse(payload: HookPayload, trace?: TraceRecorder): Promise<void> {
    for (const hook of this.matching("PostToolUse", payload.tool)) {
      trace?.record("hook_start", {
        event: "PostToolUse",
        tool: payload.tool,
        matcher: hook.matcher,
        command: hook.command,
      });

      const result = await executeHook(hook, payload);
      trace?.record("hook_end", hookTraceFields("PostToolUse", payload.tool, result, { action: "allow" }));
    }
  }

  private matching(event: HookEventName, tool: string): HookEntry[] {
    return this.config[event].filter((hook) => hook.matcher === "*" || hook.matcher === tool);
  }
}

export function loadHookConfig(): HookConfig {
  const merged: HookConfig = { PreToolUse: [], PostToolUse: [] };
  for (const filePath of [
    join(homedir(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.json"),
  ]) {
    mergeHooksFromFile(filePath, merged);
  }
  return merged;
}

export function buildHookPayload(
  event: HookEventName,
  tool: string,
  input: Record<string, any>,
  options: {
    runId?: string;
    permission?: Record<string, any>;
    result?: string;
  } = {}
): HookPayload {
  return {
    event,
    tool,
    input,
    runId: options.runId,
    cwd: process.cwd(),
    ...(options.permission ? { permission: options.permission } : {}),
    ...(options.result ? { result: summarizeResult(options.result) } : {}),
  };
}

function mergeHooksFromFile(filePath: string, target: HookConfig): void {
  if (!existsSync(filePath)) return;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const hooks = raw.hooks;
    if (!hooks || typeof hooks !== "object") return;
    for (const event of ["PreToolUse", "PostToolUse"] as HookEventName[]) {
      if (!Array.isArray(hooks[event])) continue;
      for (const item of hooks[event]) {
        if (isHookEntry(item)) {
          target[event].push({
            matcher: item.matcher,
            command: item.command,
            timeoutMs: typeof item.timeoutMs === "number" ? item.timeoutMs : undefined,
          });
        }
      }
    }
  } catch {
    // Malformed settings should not break agent startup.
  }
}

function isHookEntry(value: any): value is HookEntry {
  return value
    && typeof value === "object"
    && typeof value.matcher === "string"
    && typeof value.command === "string";
}

function executeHook(hook: HookEntry, payload: HookPayload): Promise<HookExecution> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      cwd: process.cwd(),
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({
        hook,
        durationMs: Date.now() - started,
        exitCode: null,
        stdout: summarizeText(stdout),
        stderr: summarizeText(stderr),
        timedOut: true,
      });
    }, hook.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        hook,
        durationMs: Date.now() - started,
        exitCode: null,
        stdout: summarizeText(stdout),
        stderr: summarizeText(stderr),
        timedOut: false,
        error,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        hook,
        durationMs: Date.now() - started,
        exitCode: code,
        stdout: summarizeText(stdout),
        stderr: summarizeText(stderr),
        timedOut: false,
      });
    });

    child.stdin?.end(JSON.stringify({
      ...payload,
      input: payload.input,
      traceInput: summarizeToolInput(payload.tool, payload.input),
    }));
  });
}

function interpretPreHookResult(result: HookExecution): HookDecision {
  if (result.timedOut) {
    return { action: "deny", reason: `PreToolUse hook timed out: ${result.hook.command}` };
  }
  if (result.error) {
    return { action: "deny", reason: `PreToolUse hook failed: ${formatError(result.error).message}` };
  }
  if (result.exitCode !== 0) {
    return { action: "deny", reason: `PreToolUse hook exited with code ${result.exitCode}: ${result.hook.command}` };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    result.parsed = parsed;
    if (parsed.action === "allow") return { action: "allow" };
    if (parsed.action === "deny") {
      return { action: "deny", reason: parsed.reason || `Denied by hook: ${result.hook.command}` };
    }
    return { action: "deny", reason: `PreToolUse hook returned unknown action: ${result.hook.command}` };
  } catch {
    return { action: "deny", reason: `PreToolUse hook returned invalid JSON: ${result.hook.command}` };
  }
}

function hookTraceFields(
  event: HookEventName,
  tool: string,
  result: HookExecution,
  decision: HookDecision
): Record<string, any> {
  return {
    event,
    tool,
    matcher: result.hook.matcher,
    command: result.hook.command,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    action: decision.action,
    reason: decision.reason,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ? formatError(result.error) : undefined,
  };
}
