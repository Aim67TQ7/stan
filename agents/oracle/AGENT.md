# ORACLE — Claude Code Escalation Agent

## Overview
ORACLE is the only non-containerized agent in STAN. It runs directly on the host and invokes `claude -p` (Claude Code CLI) for tasks requiring advanced reasoning, architecture decisions, code review, or complex multi-step analysis that exceeds Gemini Flash capabilities.

## How It Works
1. Orchestrator routes a task to ORACLE by writing `current-task.json` to this directory
2. The host-side `runner.js` watcher picks up the file
3. Runner builds a prompt from the task fields and calls `claude -p --output-format json`
4. Response is written to `workspace/outbox/oracle-{timestamp}.json`
5. The consumed task file is deleted

## Routing Triggers
- `assigned_to: ORACLE` in the task
- Task type: `complex`, `architecture`, `code-review`, `audit`, `oracle`
- Keyword matches: complex, architecture, code-review, audit, refactor, security

## Task Format
Tasks should include full context — ORACLE has no memory between calls:
```json
{
  "type": "code-review",
  "assigned_to": "ORACLE",
  "description": "Review the authentication flow for security issues",
  "context": "Full code or relevant file contents here",
  "instructions": "Focus on OWASP top 10 vulnerabilities"
}
```

## Token Budget
- Warning logged if a single call exceeds 10,000 output tokens
- Usage tracked per-call in `logs/usage-YYYY-MM-DD.jsonl`

## Starting the Runner
```bash
node /opt/stan/agents/oracle/runner.js
```

## Boundaries
- Stateless — no memory between invocations
- Cannot modify CLAUDE.md, .env, guardrails, or create-agent.sh
- All calls logged with token counts and duration
- 5-minute execution timeout per task
