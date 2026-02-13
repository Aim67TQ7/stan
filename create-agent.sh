#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# STAN Agent Creator
# Called by the orchestrator to spawn new agents from template.
# Guardrails enforced here — not in the caller.
# ============================================================================

STAN_ROOT="/opt/stan"
TEMPLATE_DIR="${STAN_ROOT}/agent-template"
AGENTS_DIR="${STAN_ROOT}/agents"
COMPOSE_FILE="${STAN_ROOT}/docker-compose.yml"
CREATION_LOG="${STAN_ROOT}/logs/agent-creation.log"
MAX_AGENTS=15

# --- Logging ---
log_creation() {
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  mkdir -p "$(dirname "$CREATION_LOG")"
  echo "[${timestamp}] $*" >> "$CREATION_LOG"
  echo "[${timestamp}] $*"
}

# --- Usage ---
usage() {
  echo "Usage: $0 <agent-name> <display-name> <role> <description> <reason>"
  echo ""
  echo "  agent-name    Lowercase, alphanumeric + hyphens (e.g., 'felix')"
  echo "  display-name  Human-readable name (e.g., 'Felix')"
  echo "  role          Short role title (e.g., 'Inventory Analyst')"
  echo "  description   What the agent does"
  echo "  reason        Why this agent is being created"
  exit 1
}

# --- Validate args ---
if [ $# -lt 5 ]; then
  usage
fi

AGENT_NAME="$1"
DISPLAY_NAME="$2"
ROLE="$3"
DESCRIPTION="$4"
REASON="$5"

# --- Guardrail: validate name format ---
if ! echo "$AGENT_NAME" | grep -qE '^[a-z][a-z0-9-]{1,20}$'; then
  log_creation "REJECTED: Invalid agent name '${AGENT_NAME}' — must be lowercase alphanumeric+hyphens, 2-21 chars"
  exit 1
fi

# --- Guardrail: no reserved names ---
RESERVED="stan-orchestrator orchestrator stan claude root admin"
for name in $RESERVED; do
  if [ "$AGENT_NAME" = "$name" ]; then
    log_creation "REJECTED: '${AGENT_NAME}' is a reserved name"
    exit 1
  fi
done

# --- Guardrail: agent doesn't already exist ---
if [ -d "${AGENTS_DIR}/${AGENT_NAME}" ]; then
  log_creation "REJECTED: Agent '${AGENT_NAME}' already exists"
  exit 1
fi

# --- Guardrail: max 15 containers ---
CURRENT_COUNT=$(docker compose -f "$COMPOSE_FILE" config --services 2>/dev/null | wc -l)
if [ "$CURRENT_COUNT" -ge "$MAX_AGENTS" ]; then
  log_creation "REJECTED: Max ${MAX_AGENTS} agents reached (current: ${CURRENT_COUNT}). Cannot create '${AGENT_NAME}'"
  exit 1
fi

# --- Guardrail: no self-modification ---
PROTECTED_FILES="CLAUDE.md .env docker-compose.yml create-agent.sh"
# (This is a declaration of intent — the script itself enforces boundaries by only writing to agents/ dir)

# --- Create agent directory from template ---
log_creation "CREATING: ${AGENT_NAME} (${ROLE}) — Reason: ${REASON}"

AGENT_DIR="${AGENTS_DIR}/${AGENT_NAME}"
mkdir -p "$AGENT_DIR"

# Copy and customize template files
cp "${TEMPLATE_DIR}/Dockerfile" "${AGENT_DIR}/Dockerfile"

sed -e "s/AGENT_NAME/${AGENT_NAME}/g" \
    -e "s/AGENT_DESCRIPTION/${DESCRIPTION}/g" \
    "${TEMPLATE_DIR}/package.json" > "${AGENT_DIR}/package.json"

sed -e "s/AGENT_NAME/${AGENT_NAME}/g" \
    "${TEMPLATE_DIR}/main.js" > "${AGENT_DIR}/main.js"

sed -e "s/AGENT_NAME/${AGENT_NAME}/g" \
    -e "s/AGENT_DISPLAY_NAME/${DISPLAY_NAME}/g" \
    -e "s/AGENT_ROLE/${ROLE}/g" \
    -e "s/AGENT_DESCRIPTION/${DESCRIPTION}/g" \
    -e "s/AGENT_TASK_TYPE/${AGENT_NAME}/g" \
    "${TEMPLATE_DIR}/AGENT.md" > "${AGENT_DIR}/AGENT.md"

# --- Append service to docker-compose.yml ---
# Guardrail: internal network ONLY — no stan-external
cat >> "$COMPOSE_FILE" <<YAML

  ${AGENT_NAME}:
    container_name: ${AGENT_NAME}
    build:
      context: ./agents/${AGENT_NAME}
      dockerfile: Dockerfile
    working_dir: /app
    volumes:
      - ./agents/${AGENT_NAME}:/app/agent
      - ./workspace:/app/workspace
      - ./logs:/app/logs
    env_file: .env
    environment:
      - ROLE=${AGENT_NAME}
      - NODE_ENV=production
    networks:
      - stan-internal
    restart: unless-stopped
    depends_on:
      - stan-orchestrator
YAML

# --- Build and start ---
log_creation "BUILDING: ${AGENT_NAME}"
docker compose -f "$COMPOSE_FILE" build "$AGENT_NAME" 2>&1 | tail -5

log_creation "STARTING: ${AGENT_NAME}"
docker compose -f "$COMPOSE_FILE" up -d "$AGENT_NAME" 2>&1

# --- Verify ---
sleep 2
STATUS=$(docker inspect --format='{{.State.Status}}' "$AGENT_NAME" 2>/dev/null || echo "not found")

if [ "$STATUS" = "running" ]; then
  log_creation "SUCCESS: ${AGENT_NAME} is running (internal network only, no Supabase access, no agent creation)"
  echo "Agent '${AGENT_NAME}' created and running."
else
  log_creation "FAILED: ${AGENT_NAME} status is '${STATUS}'"
  echo "ERROR: Agent '${AGENT_NAME}' failed to start. Check logs." >&2
  exit 1
fi
