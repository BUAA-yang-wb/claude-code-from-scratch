# AGENTS.md

Project guide for coding agents working in this repository.

## Mission

- This is a learning and second-development project based on `claude-code-from-scratch`.
- The user's goal is to learn Agent architecture, build practical Agent engineering experience, and package the result as a resume-ready internship project.
- Main direction: a TypeScript-first AgentOps Coding Agent with tracing, hooks, evals, safety audit, and MCP-oriented extensibility.
- Treat this as an Agent runtime project, not a generic chatbot. Focus on tools, permissions, context, memory, sub-agents, MCP, observability, and evaluation.

## Scope

- Primary code path: TypeScript under `src/`.
- `python/` is reference material only unless the user explicitly asks for Python work.
- Do not delete or broadly refactor the Python implementation.
- Do not mirror TS changes into Python by default.
- User-facing docs may be Chinese; code, identifiers, config keys, and file names stay English.
- Use project-local dependencies only. Do not run `npm link` or install this package globally.

## Local Commands

On this Windows workspace, use `npm.cmd` instead of bare `npm`.

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

- `.npmrc` sets npm cache to `node_modules/.cache/npm`.
- `node_modules/` and `dist/` are generated and ignored.
- Minimum verification after TS changes: `npm.cmd run build`.

## API Configuration

- TypeScript compilation does not need an API key; running the agent does.
- Never commit secrets.
- Preferred project key: `DEEPSEEK_API_KEY_MINICC`.
- When `DEEPSEEK_API_KEY_MINICC` is set, TS CLI defaults to OpenAI-compatible DeepSeek mode:
  - base URL: `https://api.deepseek.com`
  - model: `deepseek-v4-pro`
- `MINI_CLAUDE_MODEL` or `--model` overrides the model.
- Other supported env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

## Important Files

- `README_EN.md`: reliable overview when Chinese README encoding is unclear.
- `docs/13-whats-next.md`: extension ideas and missing production features.
- `docs/14-testing.md`: manual test guide.
- `my-docs/agent-learning-plan.md`: current learning and development plan.
- `.mcp.json`: local test MCP server config.
- `.claude/`: sample rules, skills, and custom agents.
- `my-docs/AGENTS-CN.md`: Chinese reading version of this guide.

## Architecture Map

- `src/agent.ts`: Agent loop, model calls, streaming, tool feedback, context compression, budget, Plan Mode, sub-agent execution.
- `src/tools.ts`: tool schemas, read/write/edit/search/shell/web tools, permissions, dangerous command detection, deferred tool activation.
- `src/mcp.ts`: MCP JSON-RPC over stdio client and tool routing.
- `src/subagent.ts`: built-in and custom sub-agent discovery/config.
- `src/memory.ts`: memory types, semantic recall, async prefetch.
- `src/skills.ts`: skill discovery and prompt resolution.
- `src/prompt.ts`: system prompt, `@include`, `.claude/rules`, git context.
- `src/cli.ts`: args, REPL, slash commands, session restore.
- `src/session.ts`: conversation persistence.
- `src/ui.ts`: terminal rendering.

## Coding Rules

- Keep edits small, focused, and behavior-driven.
- Follow the existing ESM TypeScript style with simple modules and explicit functions.
- Avoid broad refactors while learning.
- Preserve existing safety checks, permission behavior, read-before-edit, and mtime protections.
- Do not commit generated files, caches, or secrets.
- If a file has user changes, inspect and work with them; do not revert them.
- Prefer `rg` for search.

## Test Focus

Use `docs/14-testing.md` for manual behavior checks. Pick tests relevant to the changed area:

- Tools: read file, edit file, grep search, dangerous shell rejection.
- Agent loop: one-shot prompt reading `package.json`.
- Context: large file read from `test/large-file.txt`.
- Memory: save memory and semantic recall.
- Skills: `/skills` and one sample skill.
- Sub-agent: `explore` or `plan` agent on `src/`.
- MCP: test server tools from `.mcp.json`.
- Plan Mode: `/plan`, read-only restriction, approval flow.

When API keys are unavailable, still run `npm.cmd run build`.
