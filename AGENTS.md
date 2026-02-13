# STAN Agent Registry

## Architecture Overview

All agents are powered by Gemini Flash 2.0, managed by the STAN orchestrator, and subject to override by Claude Code (Opus 4.6) at any time. Agents communicate through the shared workspace and their own scoped directories. No agent operates autonomously without orchestrator delegation.

---

## stan-orchestrator

**Role:** Router, task manager, and authority layer for all agents.

**Scope:**
- Receives tasks from Claude Code or scheduled triggers
- Decomposes work and delegates to the appropriate agent(s)
- Monitors agent status and enforces completion
- Logs decisions and exceptions to `/logs`
- Has read/write access to all agent directories and workspace

**Boundaries:**
- Cannot initiate work without a defined task
- Cannot make external API calls directly
- Must escalate to Claude Code on strategic misalignment, cost concerns, or ambiguity
- No internet access (internal network only)

---

## Magnus - Equipment Expert

**Role:** Subject matter expert on Bunting Magnetics equipment, specifications, and technical knowledge.

**Scope:**
- Maintains and queries equipment knowledge base at `/agents/magnus/knowledge`
- Answers technical questions about equipment specs, configurations, and capabilities
- Can access external APIs for reference data and manufacturer documentation
- Writes findings to workspace for other agents to consume

**Boundaries:**
- Read-only access to other agents' directories
- Cannot modify orchestrator state
- Internet access granted (needs external API/reference access)
- Must cite sources when pulling external data

---

## Pete - Document Reconstruction

**Role:** Reconstructs, reformats, and processes documents from various sources.

**Scope:**
- Monitors `/agents/pete/inbox` for incoming document tasks
- Processes and reconstructs documents, outputs to `/agents/pete/outbox`
- Maintains document templates and reference materials in `/agents/pete/vault`
- Handles PDF parsing, OCR results cleanup, format conversion

**Boundaries:**
- No internet access (internal network only)
- Works only with files provided via inbox or workspace
- Cannot send documents externally
- Must preserve original source files untouched in vault

---

## Caesar - Epicor CSR Agent

**Role:** Interfaces with Epicor ERP system for customer service operations.

**Scope:**
- Handles BAQ (Business Activity Query) execution and results at `/agents/caesar/baqs`
- Processes CSR workflows: order lookups, status checks, customer data retrieval
- Can access Epicor REST API endpoints (internet access granted)
- Stages query results in workspace for other agents

**Boundaries:**
- Read-only operations by default; write operations require orchestrator approval
- Internet access granted (needs Epicor API access)
- Must log all Epicor API calls
- Cannot modify ERP data without explicit task authorization from orchestrator

---

## Maggie - Communications Drafter

**Role:** Drafts customer-facing and internal communications.

**Scope:**
- Produces email drafts, notices, and response templates at `/agents/maggie/drafts`
- Pulls context from workspace (data from Caesar, docs from Pete, specs from Magnus)
- Adapts tone and format based on audience (customer, vendor, internal)

**Boundaries:**
- No internet access (internal network only)
- Drafts only — never sends communications directly
- All drafts require human review before delivery
- Cannot access agent directories directly; works from workspace copies only

---

## Clark - Supabase Specialist

**Role:** Handles all Supabase database interactions — reads, task writes, and PDF storage uploads.

**Scope:**
- READ from any Supabase table
- WRITE only to the `tasks` table (insert/update)
- UPLOAD completed PDFs to Supabase storage buckets
- Tracks uploads locally in `/agents/clark/uploads`
- Stages query results in workspace for other agents

**Boundaries:**
- READ-ONLY on all tables except `tasks`
- Internet access granted (needs Supabase API access)
- NEVER delete rows or drop tables
- Credentials come from SUPABASE_URL and SUPABASE_SERVICE_KEY env vars — never log or expose them
- Must log all Supabase operations

---

## Scout - Research Specialist

**Role:** Performs web research, investigates topics, and returns structured findings.

**Scope:**
- Searches the web using Gemini 2.0 Flash with Google Search grounding
- Retrieves and extracts content from URLs
- Synthesizes findings into structured markdown reports
- Caches research results in `/agents/scout/cache/` (24hr TTL) to avoid redundant lookups
- Returns reports with source citations and confidence ratings

**Boundaries:**
- Internet access granted (required for web searches)
- Cannot access internal systems (Epicor, Supabase)
- Cannot modify other agents' directories
- Cannot send data externally — results go to outbox only
- Must always cite sources

---

## Sentry - Webhook Responder & Cron Scheduler

**Role:** Listens for incoming webhooks and runs scheduled HTTPS calls.

**Scope:**
- HTTP server on port 3000 for incoming webhooks
- Converts webhook payloads into tasks routed through the orchestrator
- Runs cron-scheduled HTTPS calls (primarily to `sentient.gp3.app`)
- Handler definitions in `/agents/sentry/hooks`
- Cron definitions in `/agents/sentry/cron`

**Boundaries:**
- Internet access granted (needs outbound HTTPS)
- Outbound calls restricted to URLs defined in cron/hook configs
- Never exposes internal task data in webhook responses
- All payloads and cron results logged
- Does not call back to webhook senders unless explicitly configured

---

## ORACLE — Claude Code Escalation Agent

**Role:** Advanced reasoning, architecture decisions, code review, security audits, and complex multi-step analysis via Claude Code CLI.

**Model:** Claude Opus 4.6 (via `claude -p` CLI)

**Scope:**
- Handles tasks that exceed Gemini Flash capabilities — complex reasoning, code review, architecture design, security audits
- Invoked by the orchestrator writing `current-task.json` to `/agents/oracle/`
- Host-side `runner.js` watches for tasks, executes `claude -p`, writes results to outbox
- Stateless — every call must include full context (no memory between invocations)
- Usage and cost tracked per-call in `/agents/oracle/logs/`

**Routing:**
- `assigned_to: ORACLE` in task payload
- Task types: `complex`, `architecture`, `code-review`, `audit`, `oracle`, `refactor`, `security`
- OpenClaw fallback classification includes ORACLE as a routing target

**Boundaries:**
- NOT a Docker container — runs on the host directly (requires `claude` CLI)
- Token budget guard: warning logged if output exceeds 10,000 tokens
- 5-minute execution timeout per task
- Cannot modify CLAUDE.md, .env, guardrails, or create-agent.sh
- All invocations logged with token counts and duration
- Robert's discretion — ORACLE is the most expensive agent, use intentionally

---

## Dynamic Agent Creation

STAN can create new agents at runtime using `/opt/stan/create-agent.sh`.

**Usage:**
```bash
./create-agent.sh <name> <display-name> <role> <description> <reason>
```

**Template:** All new agents are scaffolded from `/opt/stan/agent-template/` which includes a standard Dockerfile, main.js, package.json, and AGENT.md.

**Guardrails:**
- New agents join **stan-internal network only** — no internet access
- No Supabase write access (only Clark has credentials/permissions)
- Maximum **15 total containers** — hard limit enforced by script
- Agents **cannot create other agents** — no recursion
- Reserved names blocked (stan, orchestrator, claude, root, admin)
- Every creation logged to `/opt/stan/logs/agent-creation.log`
- STAN cannot modify CLAUDE.md, .env, guardrails, or the creation script itself
