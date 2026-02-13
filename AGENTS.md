# STAN Agent Registry

## Architecture Overview

All agents are powered by Gemini Flash 2.0, managed by the STAN orchestrator, and subject to override by Claude Code (Opus 4.6) at any time. Agents communicate through the shared workspace and their own scoped directories. No agent operates autonomously without orchestrator delegation.

---

## stan-orchestrator (Level 3 Autonomy)

**Role:** Router, task manager, authority layer, and workflow orchestrator for all agents.

**Scope:**
- Receives tasks from Claude Code, Supabase (via Sentry), scheduled triggers, or direct chat
- Decomposes complex tasks into multi-agent workflows (up to 5 sequential subtasks)
- Delegates to the appropriate agent(s) and updates task status to `in_progress` via Clark
- Polls inbox every 30 seconds as backup to chokidar file watcher
- Monitors agent status and enforces completion
- Logs decisions and exceptions to `/logs`
- Has read/write access to all agent directories and workspace

**Boundaries:**
- Cannot create autonomous loops that spend tokens without a task triggering it
- Cannot make external API calls directly
- Must escalate to Claude Code on strategic misalignment, cost concerns, or ambiguity
- No internet access (internal network only)
- Cannot modify CLAUDE.md, guardrails, .env, or create-agent.sh
- Cannot exceed 15 container limit

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

## Clark - Supabase Specialist & Result Pipeline

**Role:** Handles all Supabase database interactions, watches outbox for agent results, uploads deliverables, and closes the task lifecycle loop.

**Scope:**
- READ from any Supabase table
- WRITE to `tasks`, `agent_status`, `agent_activity`, `scheduled_tasks`
- UPLOAD files to Supabase storage buckets (deliverables, completed-pdfs)
- Watches `workspace/outbox/` for agent results via chokidar
- On result: appends to task `updates` JSONB array with agent name, content, timestamp, and deliverable
- Deliverables include type (pdf, audio, text, image, document, link) and public URL for UI rendering
- File deliverables automatically uploaded to Supabase storage `deliverables` bucket
- Sets task status to `done` when result is written
- Watches `agent-status.json` and syncs to Supabase `agent_status` table
- Polls `scheduled_tasks` every 60s and dispatches due tasks
- Tracks uploads locally in `/agents/clark/uploads`

**Boundaries:**
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

## Sentry - Webhook Responder, Cron Scheduler & Chat Gateway

**Role:** Listens for incoming webhooks, runs scheduled HTTPS calls, polls Supabase for new tasks, and provides direct chat with STAN.

**Scope:**
- HTTP server on port 3000 for incoming webhooks and chat
- `POST /hook/new-task` — Supabase webhook receiver for new tasks
- `POST /hook/:name` — generic webhook handlers
- `POST /chat/stan` — direct real-time chat with STAN (accepts `{message, user_id}`)
- Polls Supabase `tasks` table every 30s for `status='inbox'` items
- Converts webhook/poll payloads into tasks routed through the orchestrator
- Marks tasks `in_progress` in Supabase on pickup (prevents re-polling)
- Runs cron-scheduled HTTPS calls from JSON definitions
- Handler definitions in `/agents/sentry/hooks`
- Cron definitions in `/agents/sentry/cron`

**Boundaries:**
- Internet access granted (needs outbound HTTPS + Supabase)
- Outbound calls restricted to URLs defined in cron/hook configs + Supabase
- Chat responses are synchronous — no task pipeline for conversation
- Never exposes internal task data in webhook responses
- All payloads, cron results, and chat messages logged

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

## Multi-User Model

All user-facing data is scoped by `user_id` with Supabase Row Level Security.

| Table | RLS Policy | Notes |
|-------|-----------|-------|
| tasks | SELECT, INSERT, UPDATE own | `user_id = auth.uid()` |
| scheduled_tasks | SELECT, INSERT, UPDATE, DELETE own | `user_id = auth.uid()` |
| agent_activity | SELECT own | `user_id = auth.uid()` |
| agent_status | SELECT all authenticated | Shared health dashboard |

**Key design:**
- `user_id` defaults to `auth.uid()` on INSERT (set by Postgres, not the app)
- Clark uses `service_key` which bypasses RLS for backend operations
- Frontend clients use `anon` key + user JWT — RLS filters automatically
- `user_id` flows through the full pipeline: Supabase webhook → Sentry → Orchestrator → Agent → Clark
- Clark preserves `user_id` on all writes when present in the routed task

**Scheduled tasks:** Users create cron-scheduled tasks in Supabase. Clark polls every 60s, dispatches due tasks to the orchestrator inbox with `user_id`, and computes the next run time.

---

## Health Monitoring & Skills

### Health Endpoints
All agents expose a `/health` endpoint returning real-time status:

| Agent | Endpoint | Port |
|-------|----------|------|
| magnus, pete, caesar, maggie, clark, scout | `http://{name}:3001/health` | 3001 |
| sentry | `http://sentry:3000/health` | 3000 |
| oracle | `http://localhost:3002/health` + `health.json` file | 3002 |

**Response fields:** `agent`, `status`, `last_task_at`, `current_task`, `api_key_valid`, `loaded_skills`, `uptime_seconds`

### Health Monitor
The orchestrator polls all agent health endpoints every 30 seconds and writes the combined status to `/opt/stan/workspace/agent-status.json`. Clark watches this file and syncs each agent's status to the Supabase `agent_status` table.

### Skills Registry
Skills are defined in `/opt/stan/skills/registry.json`. Each agent loads its skill list at startup and reports it via the health endpoint. Shared skills (task-processing, workspace-output, logging, gemini-flash) are common to all agents; custom skills are agent-specific.

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
