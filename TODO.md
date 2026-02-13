# STAN — Items Needing Your Input

## BLOCKING — Required Before Containers Can Run

### 1. GEMINI_API_KEY
- **What:** Google AI Studio API key for Gemini Flash 2.0
- **Where:** Set as environment variable on the host: `export GEMINI_API_KEY=your_key_here`
- **Get it:** https://aistudio.google.com/ → "Get API Key"
- **Used by:** All 5 containers (orchestrator + 4 agents)

### 2. Epicor Credentials (Caesar agent)
- **EPICOR_BASE_URL** — Your Epicor REST API base URL (e.g., `https://your-company.epicorsaas.com/api/v2`)
- **EPICOR_API_KEY** — Epicor API key or Bearer token
- **Where:** Set as environment variables on the host
- **Note:** Caesar will run without these but cannot make live Epicor calls

## NON-BLOCKING — Can Be Done After First Launch

### 3. Magnus Knowledge Base
- Add equipment Markdown files to `/opt/stan/agents/magnus/knowledge/`
- One file per product line or category recommended
- Magnus reads all `.md` files in this directory at task time

### 4. Pete's Vault
- Add company logos, letterhead templates, and reference documents to `/opt/stan/agents/pete/vault/`
- Pete checks vault for templates before building from scratch

### 5. Caesar BAQ Definitions
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

### 6. .env File (Optional Convenience)
- Create `/opt/stan/.env` with all keys to avoid exporting each time:
```
GEMINI_API_KEY=your_key
EPICOR_BASE_URL=your_url
EPICOR_API_KEY=your_key
```
- docker-compose automatically reads `.env` from the project root
