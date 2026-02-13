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
  hook: 'sentry'
};

async function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  const logFile = path.join(LOGS, `orchestrator-${new Date().toISOString().split('T')[0]}.log`);
  await writeFile(logFile, entry, { flag: 'a' }).catch(() => {});
  console.log(entry.trim());
}

function routeTask(task) {
  const type = (task.type || '').toLowerCase();
  const content = (task.description || '').toLowerCase();

  // Direct match on task type
  if (AGENT_ROUTES[type]) return AGENT_ROUTES[type];

  // Keyword scan on description
  for (const [keyword, agent] of Object.entries(AGENT_ROUTES)) {
    if (content.includes(keyword)) return agent;
  }

  return null;
}

async function classifyWithOpenClaw(task) {
  const prompt = `You are a task router. Given this task, respond with ONLY one word: magnus, pete, caesar, maggie, clark, or sentry.

magnus = equipment/technical questions about Bunting Magnetics
pete = document reconstruction, formatting, PDF processing
caesar = Epicor ERP, orders, customer service, BAQ queries
maggie = drafting emails, letters, communications
clark = Supabase database queries, task writes, PDF uploads to storage
sentry = webhooks, cron scheduling, periodic HTTP calls

Task: ${JSON.stringify(task)}

Agent:`;

  try {
    const { stdout } = await exec('openclaw', ['agent', '--message', prompt], {
      timeout: 30000,
      env: { ...process.env }
    });
    const agent = stdout.trim().toLowerCase().split('\n').pop().trim();
    if (['magnus', 'pete', 'caesar', 'maggie', 'clark', 'sentry'].includes(agent)) {
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
