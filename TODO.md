# STAN — Items Needing Your Input

## BLOCKING — Required Before Containers Can Run

### 1. GEMINI_API_KEY
- **What:** Google AI Studio API key for Gemini Flash 2.0
- **Where:** `/opt/stan/.env` → `GEMINI_API_KEY=`
- **Get it:** https://aistudio.google.com/ → "Get API Key"
- **Used by:** All 7 containers (orchestrator + 6 agents)

### 2. Epicor Credentials (Caesar agent)
- **Auth method:** Basic Auth (username/password) + API key header
- **EPICOR_BASE_URL** — `https://epicor.buntingmagnetics.com/EpicorProd` (pre-filled)
- **EPICOR_API_KEY** — Epicor API key sent as `x-api-key` header
- **EPICOR_USERNAME** — Epicor login username
- **EPICOR_PASSWORD** — Epicor login password
- **EPICOR_COMPANIES** — `BMC,BME,MAI` (pre-filled)
- **Where:** `/opt/stan/.env`
- **Company codes:** BMC (Bunting Magnetics Co.), BME (Bunting Magnetics Europe), MAI (Magnet Applications Inc.)
- **Note:** Caesar will run without these but cannot make live Epicor calls

### 3. Supabase Credentials (Clark agent)
- **SUPABASE_URL** — Your Supabase project URL (e.g., `https://xxxx.supabase.co`)
- **SUPABASE_SERVICE_KEY** — Supabase service role key (NOT the anon key — Clark needs service-level access)
- **Where:** `/opt/stan/.env`
- **Note:** Clark will run without these but cannot make live Supabase calls

## NON-BLOCKING — Can Be Done After First Launch

### 4. Magnus Knowledge Base
- Add equipment Markdown files to `/opt/stan/agents/magnus/knowledge/`
- One file per product line or category recommended
- Magnus reads all `.md` files in this directory at task time

### 5. Pete's Vault
- Add company logos, letterhead templates, and reference documents to `/opt/stan/agents/pete/vault/`
- Pete checks vault for templates before building from scratch

### 6. Caesar BAQ Definitions
- Add BAQ definition JSON files to `/opt/stan/agents/caesar/baqs/`
- Format per BAQ:
```json
{
  "name": "OrderStatus",
  "description": "Look up order status by order number",
  "endpoint": "/BaqSvc/OrderStatus",
  "parameters": ["OrderNum"],
  "response_fields": ["OrderNum", "OrderDate", "ShipDate", "Status"]
}
```

### 7. Sentry Webhook Handlers
- Add webhook handler JSON files to `/opt/stan/agents/sentry/hooks/`
- Format per handler:
```json
{
  "name": "order-update",
  "description": "Triggered when an order status changes",
  "task_type": "epicor",
  "route_to": "order"
}
```

### 8. Sentry Cron Jobs
- Add cron definition JSON files to `/opt/stan/agents/sentry/cron/`
- Format per job:
```json
{
  "name": "health-check",
  "schedule": "*/5 * * * *",
  "url": "https://sentient.gp3.app/health",
  "method": "GET",
  "headers": {},
  "on_failure": "log"
}
```
