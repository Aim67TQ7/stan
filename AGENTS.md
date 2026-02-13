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
