#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { Agent } from "./agent.js";
import { TraceRecorder, readTraceEvents, type TraceEvent } from "./trace.js";
import type { PermissionMode } from "./tools.js";

interface EvalCase {
  name: string;
  prompt: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  expect?: {
    contains?: string[];
    toolCalled?: string[];
    permission?: "allowed" | "denied";
    traceFile?: boolean;
  };
}

interface EvalResult {
  name: string;
  ok: boolean;
  durationMs: number;
  output: string;
  traceFile: string;
  failures: string[];
}

const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-pro";
const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";

async function main() {
  const evalPath = resolve(process.argv[2] || "evals");
  const cases = loadEvalCases(evalPath);
  if (cases.length === 0) {
    console.error(`No eval cases found at ${evalPath}`);
    process.exit(1);
  }

  const api = resolveApiConfig();
  if (!api.apiKey) {
    console.error(
      "Eval Runner requires an API key. Set DEEPSEEK_API_KEY_MINICC, ANTHROPIC_API_KEY, or OPENAI_API_KEY."
    );
    process.exit(1);
  }

  const results: EvalResult[] = [];
  for (const testCase of cases) {
    const result = await runEvalCase(testCase, api);
    results.push(result);
    const marker = result.ok ? "PASS" : "FAIL";
    console.log(`${marker} ${testCase.name} (${result.durationMs}ms)`);
    for (const failure of result.failures) {
      console.log(`  - ${failure}`);
    }
  }

  const resultDir = join(process.cwd(), ".mini-claude", "eval-results");
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, `${timestamp()}-results.json`);
  writeFileSync(resultPath, JSON.stringify({ results }, null, 2), "utf-8");

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nEval summary: ${results.length - failed}/${results.length} passed`);
  console.log(`Results: ${resultPath}`);
  if (failed > 0) process.exit(1);
}

async function runEvalCase(
  testCase: EvalCase,
  api: ReturnType<typeof resolveApiConfig>
): Promise<EvalResult> {
  const started = Date.now();
  const traceFile = join(
    process.cwd(),
    ".mini-claude",
    "traces",
    `eval-${safeName(testCase.name)}-${timestamp()}.jsonl`
  );
  const trace = new TraceRecorder({ filePath: traceFile });
  const agent = new Agent({
    permissionMode: testCase.permissionMode || "dontAsk",
    model: api.model,
    apiBase: api.useOpenAI ? api.apiBase : undefined,
    anthropicBaseURL: !api.useOpenAI ? api.apiBase : undefined,
    apiKey: api.apiKey,
    maxTurns: testCase.maxTurns,
    trace,
  });

  let output = "";
  let error: unknown;
  try {
    const response = await agent.runOnce(testCase.prompt);
    output = response.text;
  } catch (err) {
    error = err;
  }

  const events = existsSync(traceFile) ? readTraceEvents(traceFile) : [];
  const failures = assertExpectations(testCase, output, events, traceFile);
  if (error) failures.push(`agent error: ${error instanceof Error ? error.message : String(error)}`);

  return {
    name: testCase.name,
    ok: failures.length === 0,
    durationMs: Date.now() - started,
    output,
    traceFile,
    failures,
  };
}

function assertExpectations(
  testCase: EvalCase,
  output: string,
  events: TraceEvent[],
  traceFile: string
): string[] {
  const failures: string[] = [];
  const expect = testCase.expect || {};

  for (const text of expect.contains || []) {
    if (!output.includes(text)) failures.push(`expected output to contain "${text}"`);
  }

  for (const tool of expect.toolCalled || []) {
    const called = events.some((e) =>
      (e.type === "tool_call_start" || e.type === "tool_call_end") && e.tool === tool
    );
    if (!called) failures.push(`expected tool call: ${tool}`);
  }

  if (expect.permission) {
    const wantDenied = expect.permission === "denied";
    const found = events.some((e) =>
      e.type === "permission_check"
      && (wantDenied ? e.action === "deny" : e.action === "allow")
    );
    if (!found) failures.push(`expected permission ${expect.permission}`);
  }

  if (expect.traceFile) {
    if (!existsSync(traceFile)) failures.push("expected trace file to be created");
    if (events.length === 0) failures.push("expected trace file to contain events");
  }

  return failures;
}

function loadEvalCases(evalPath: string): EvalCase[] {
  const files = statSync(evalPath).isDirectory()
    ? readdirSync(evalPath)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(evalPath, name))
    : [evalPath];

  const cases: EvalCase[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      validateCase(item, file);
      cases.push(item);
    }
  }
  return cases;
}

function validateCase(value: any, file: string): asserts value is EvalCase {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid eval case in ${file}: expected object`);
  }
  if (typeof value.name !== "string" || typeof value.prompt !== "string") {
    throw new Error(`Invalid eval case in ${file}: name and prompt are required strings`);
  }
}

function resolveApiConfig() {
  let model = process.env.MINI_CLAUDE_MODEL
    || (process.env.DEEPSEEK_API_KEY_MINICC ? DEEPSEEK_DEFAULT_MODEL : "claude-opus-4-6");
  let apiBase: string | undefined;
  let apiKey: string | undefined;
  let useOpenAI = false;

  if (process.env.DEEPSEEK_API_KEY_MINICC) {
    apiKey = process.env.DEEPSEEK_API_KEY_MINICC;
    apiBase = DEEPSEEK_OPENAI_BASE_URL;
    useOpenAI = true;
  } else if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
    apiKey = process.env.OPENAI_API_KEY;
    apiBase = process.env.OPENAI_BASE_URL;
    useOpenAI = true;
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    apiBase = process.env.ANTHROPIC_BASE_URL;
    useOpenAI = false;
  } else if (process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
    apiBase = process.env.OPENAI_BASE_URL;
    useOpenAI = true;
  }

  if (process.env.MINI_CLAUDE_MODEL) model = process.env.MINI_CLAUDE_MODEL;
  return { model, apiBase, apiKey, useOpenAI };
}

function safeName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "case";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
