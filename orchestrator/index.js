import { watch } from 'chokidar';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const exec = promisify(execFile);

const INBOX = '/app/workspace/inbox';
const OUTBOX = '/app/workspace/outbox';
const LOGS = '/app/logs';
const AGENTS_DIR = '/app/agents';
const STATUS_FILE = '/app/workspace/agent-status.json';

const ORACLE_ROUTES = {
  complex: 'oracle',
  architecture: 'oracle',
  'code-review': 'oracle',
  audit: 'oracle',
  oracle: 'oracle',
  refactor: 'oracle',
  security: 'oracle'
};

const AGENT_ROUTES = {
  equipment: 'magnus',
  technical: 'magnus',
  knowledge: 'magnus',
  document: 'pete',
  reconstruct: 'pete',
  pdf: 'pete',
  format: 'pete',
  epicor: 'caesar',
  order: 'caesar',
  csr: 'caesar',
  baq: 'caesar',
  customer: 'caesar',
  email: 'maggie',
  draft: 'maggie',
  communication: 'maggie',
  letter: 'maggie',
  respond: 'maggie',
  supabase: 'clark',
  query: 'clark',
  upload: 'clark',
  'task-write': 'clark',
  database: 'clark',
  webhook: 'sentry',
  cron: 'sentry',
  schedule: 'sentry',
  hook: 'sentry',
  research: 'scout',
  search: 'scout',
  investigate: 'scout',
  lookup: 'scout',
  'find out': 'scout',
  web: 'scout'
};

// Health monitoring config
const HEALTH_TARGETS = [
  { name: 'magnus', url: 'http://magnus:3001/health' },
  { name: 'pete', url: 'http://pete:3001/health' },
  { name: 'caesar', url: 'http://caesar:3001/health' },
  { name: 'maggie', url: 'http://maggie:3001/health' },
  { name: 'clark', url: 'http://clark:3001/health' },
  { name: 'scout', url: 'http://scout:3001/health' },
  { name: 'sentry', url: 'http://sentry:3000/health' }
];

async function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  const logFile = path.join(LOGS, `orchestrator-${new Date().toISOString().split('T')[0]}.log`);
  await writeFile(logFile, entry, { flag: 'a' }).catch(() => {});
  console.log(entry.trim());
}

// --- Health Monitor ---

async function pollAgent(target) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(target.url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return { agent: target.name, status: 'unhealthy', error: `HTTP ${response.status}` };
    }

    return await response.json();
  } catch (err) {
    return { agent: target.name, status: 'unreachable', error: err.message };
  }
}

async function getOracleHealth() {
  const healthFile = path.join(AGENTS_DIR, 'oracle', 'health.json');
  try {
    const raw = await readFile(healthFile, 'utf-8');
    const health = JSON.parse(raw);
    // Check if heartbeat is stale (>60s)
    const age = Date.now() - new Date(health.last_updated || 0).getTime();
    if (age > 60000 && !health.uptime_seconds) {
      return { agent: 'oracle', status: 'stale', error: 'Health file older than 60s' };
    }
    return health;
  } catch {
    return { agent: 'oracle', status: 'offline', error: 'No health file found' };
  }
}

async function runHealthCheck() {
  const results = await Promise.all(HEALTH_TARGETS.map(pollAgent));
  const oracleHealth = await getOracleHealth();
  results.push(oracleHealth);

  const statusData = {
    polled_at: new Date().toISOString(),
    agents: {}
  };

  for (const result of results) {
    statusData.agents[result.agent] = result;
  }

  await writeFile(STATUS_FILE, JSON.stringify(statusData, null, 2));
}

function startHealthMonitor() {
  // Run immediately, then every 30 seconds
  runHealthCheck().catch(err => log(`Health check error: ${err.message}`));
  setInterval(() => {
    runHealthCheck().catch(err => log(`Health check error: ${err.message}`));
  }, 30000);
}

// --- Task Routing ---

function routeTask(task) {
  const type = (task.type || '').toLowerCase();
  const assignedTo = (task.assigned_to || '').toUpperCase();
  const content = (task.description || '').toLowerCase();

  // Explicit ORACLE assignment
  if (assignedTo === 'ORACLE') return 'oracle';

  // ORACLE type/keyword match (checked before general routes)
  if (ORACLE_ROUTES[type]) return 'oracle';
  for (const keyword of Object.keys(ORACLE_ROUTES)) {
    if (content.includes(keyword)) return 'oracle';
  }

  // Direct match on task type
  if (AGENT_ROUTES[type]) return AGENT_ROUTES[type];

  // Keyword scan on description
  for (const [keyword, agent] of Object.entries(AGENT_ROUTES)) {
    if (content.includes(keyword)) return agent;
  }

  return null;
}

async function classifyWithOpenClaw(task) {
  const prompt = `You are a task router. Given this task, respond with ONLY one word: magnus, pete, caesar, maggie, clark, sentry, scout, or oracle.

magnus = equipment/technical questions about Bunting Magnetics
pete = document reconstruction, formatting, PDF processing
caesar = Epicor ERP, orders, customer service, BAQ queries
maggie = drafting emails, letters, communications
clark = Supabase database queries, task writes, PDF uploads to storage
sentry = webhooks, cron scheduling, periodic HTTP calls
scout = web research, investigation, looking up information online
oracle = complex reasoning, architecture decisions, code review, security audit, refactoring

Task: ${JSON.stringify(task)}

Agent:`;

  try {
    const { stdout } = await exec('openclaw', ['agent', '--message', prompt], {
      timeout: 30000,
      env: { ...process.env }
    });
    const agent = stdout.trim().toLowerCase().split('\n').pop().trim();
    if (['magnus', 'pete', 'caesar', 'maggie', 'clark', 'sentry', 'scout', 'oracle'].includes(agent)) {
      return agent;
    }
  } catch (err) {
    await log(`OpenClaw classification failed: ${err.message}`);
  }
  return null;
}

async function dispatchToAgent(agentName, task, filename) {
  const agentWorkspace = path.join(AGENTS_DIR, agentName);
  const taskFile = path.join(agentWorkspace, 'current-task.json');

  const enrichedTask = {
    ...task,
    _routed_by: 'stan-orchestrator',
    _routed_at: new Date().toISOString(),
    _source_file: filename
  };

  await writeFile(taskFile, JSON.stringify(enrichedTask, null, 2));
  await log(`Dispatched "${task.type || 'unknown'}" task to ${agentName}: ${filename}`);
}

async function processTask(filepath) {
  const filename = path.basename(filepath);

  try {
    const raw = await readFile(filepath, 'utf-8');
    const task = JSON.parse(raw);

    await log(`New task received: ${filename}`);

    // Step 1: keyword routing
    let agent = routeTask(task);

    // Step 2: fall back to OpenClaw LLM classification
    if (!agent) {
      await log(`Keyword routing failed for ${filename}, using OpenClaw classification`);
      agent = await classifyWithOpenClaw(task);
    }

    if (!agent) {
      await log(`UNROUTABLE: ${filename} — moving to outbox with error`);
      const errorTask = { ...task, _error: 'Could not determine target agent', _status: 'unroutable' };
      await writeFile(path.join(OUTBOX, `error-${filename}`), JSON.stringify(errorTask, null, 2));
      return;
    }

    await dispatchToAgent(agent, task, filename);

    // Move processed file out of inbox
    const processedDir = path.join(INBOX, '../processed');
    await mkdir(processedDir, { recursive: true });
    await rename(filepath, path.join(processedDir, filename));

  } catch (err) {
    await log(`ERROR processing ${filename}: ${err.message}`);
  }
}

async function main() {
  await log('STAN Orchestrator starting...');
  await mkdir(INBOX, { recursive: true });
  await mkdir(OUTBOX, { recursive: true });

  // Start health monitor (polls every 30s, writes agent-status.json)
  startHealthMonitor();
  await log('Health monitor started — polling every 30s');

  const watcher = watch(INBOX, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });

  watcher.on('add', (filepath) => {
    if (filepath.endsWith('.json')) {
      processTask(filepath);
    }
  });

  await log('Watching inbox for tasks...');

  // Keep alive
  process.on('SIGTERM', async () => {
    await log('Orchestrator shutting down');
    await watcher.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  await log(`Fatal: ${err.message}`);
  process.exit(1);
});
