import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import express from 'express';
import cron from 'node-cron';
import path from 'path';

const AGENT_NAME = 'sentry';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const HOOKS_DIR = path.join(AGENT_DIR, 'hooks');
const CRON_DIR = path.join(AGENT_DIR, 'cron');
const TASK_FILE = path.join(AGENT_DIR, 'current-task.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const activeCrons = [];

async function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${AGENT_NAME}] ${message}\n`;
  const logFile = path.join(LOGS, `${AGENT_NAME}-${timestamp.split('T')[0]}.log`);
  await writeFile(logFile, entry, { flag: 'a' }).catch(() => {});
  console.log(entry.trim());
}

async function loadSystemPrompt() {
  return await readFile(path.join('/app', 'AGENT.md'), 'utf-8');
}

async function loadHookHandlers() {
  try {
    const files = await readdir(HOOKS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const handlers = {};
    for (const f of jsonFiles) {
      const content = await readFile(path.join(HOOKS_DIR, f), 'utf-8');
      try {
        const handler = JSON.parse(content);
        const name = handler.name || f.replace('.json', '');
        handlers[name] = handler;
      } catch {}
    }
    return handlers;
  } catch {
    return {};
  }
}

async function dropTaskToInbox(taskData) {
  const inboxDir = path.join(WORKSPACE, 'inbox');
  await mkdir(inboxDir, { recursive: true });
  const filename = `sentry-${Date.now()}.json`;
  await writeFile(path.join(inboxDir, filename), JSON.stringify(taskData, null, 2));
  await log(`Task dropped to inbox: ${filename}`);
}

async function executeCronJob(job) {
  await log(`Cron executing: ${job.name} → ${job.method} ${job.url}`);

  try {
    const response = await fetch(job.url, {
      method: job.method || 'GET',
      headers: job.headers || {},
      body: job.method === 'POST' ? JSON.stringify(job.body || {}) : undefined
    });

    const status = response.status;
    let body;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }

    await log(`Cron result: ${job.name} — HTTP ${status}`);

    const output = {
      agent: AGENT_NAME,
      task_source: `cron:${job.name}`,
      trigger: 'cron',
      result: { status, body },
      completed_at: new Date().toISOString()
    };

    const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-cron-${Date.now()}.json`);
    await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
    await writeFile(outFile, JSON.stringify(output, null, 2));

    return { status, body };
  } catch (err) {
    await log(`Cron FAILED: ${job.name} — ${err.message}`);
    if (job.on_failure === 'alert') {
      await dropTaskToInbox({
        type: 'communication',
        description: `Cron job '${job.name}' failed: ${err.message}`,
        audience: 'internal',
        tone: 'urgent',
        context: { cron_job: job.name, error: err.message }
      });
    }
    return { error: err.message };
  }
}

async function loadAndScheduleCrons() {
  try {
    const files = await readdir(CRON_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const f of jsonFiles) {
      const content = await readFile(path.join(CRON_DIR, f), 'utf-8');
      try {
        const job = JSON.parse(content);
        if (!job.schedule || !job.url) continue;

        const task = cron.schedule(job.schedule, () => executeCronJob(job));
        activeCrons.push(task);
        await log(`Cron scheduled: ${job.name || f} — ${job.schedule} → ${job.url}`);
      } catch (err) {
        await log(`Invalid cron file ${f}: ${err.message}`);
      }
    }
  } catch {
    await log('No cron definitions found.');
  }
}

function startWebhookServer(handlers) {
  const app = express();
  app.use(express.json());

  app.post('/hook/:name', async (req, res) => {
    const hookName = req.params.name;
    const payload = req.body;

    await log(`Webhook received: ${hookName} — ${JSON.stringify(payload).slice(0, 200)}`);

    const handler = handlers[hookName];

    const taskData = {
      type: handler?.task_type || 'webhook',
      description: handler?.description || `Webhook trigger: ${hookName}`,
      context: {
        webhook: hookName,
        payload,
        received_at: new Date().toISOString()
      }
    };

    if (handler?.route_to) {
      taskData.type = handler.route_to;
    }

    await dropTaskToInbox(taskData);

    const output = {
      agent: AGENT_NAME,
      task_source: `webhook:${hookName}`,
      trigger: 'webhook',
      result: { accepted: true },
      completed_at: new Date().toISOString()
    };

    const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-hook-${Date.now()}.json`);
    await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
    await writeFile(outFile, JSON.stringify(output, null, 2));

    res.json({ status: 'accepted', hook: hookName });
  });

  app.get('/health', (req, res) => {
    res.json({ agent: AGENT_NAME, status: 'ok', uptime: process.uptime() });
  });

  app.listen(3000, '0.0.0.0', () => {
    log('Webhook server listening on :3000');
  });
}

async function processTask(task) {
  await log(`Processing direct task: ${task.type || 'unknown'} — ${task.description || ''}`);

  const systemPrompt = await loadSystemPrompt();
  const prompt = `${systemPrompt}\n\n## Current Task\n${JSON.stringify(task, null, 2)}\n\nAnalyze the task and explain what webhook or cron configuration is needed.`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  const output = {
    agent: AGENT_NAME,
    task_source: task._source_file || 'unknown',
    trigger: 'direct',
    result: response,
    completed_at: new Date().toISOString()
  };

  const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
  await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
  await writeFile(outFile, JSON.stringify(output, null, 2));
  await log(`Task complete. Output: ${outFile}`);
}

async function main() {
  await log('Sentry agent starting...');

  // Load webhook handlers and start HTTP server
  const handlers = await loadHookHandlers();
  startWebhookServer(handlers);

  // Load and schedule cron jobs
  await loadAndScheduleCrons();

  // Also watch for direct tasks from orchestrator
  const watcher = watch(TASK_FILE, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });

  watcher.on('add', handleTask);
  watcher.on('change', handleTask);

  async function handleTask() {
    try {
      const raw = await readFile(TASK_FILE, 'utf-8');
      const task = JSON.parse(raw);
      await processTask(task);
    } catch (err) {
      await log(`Error: ${err.message}`);
    }
  }

  await log('Watching for tasks...');

  process.on('SIGTERM', async () => {
    await log('Shutting down');
    activeCrons.forEach(t => t.stop());
    await watcher.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  await log(`Fatal: ${err.message}`);
  process.exit(1);
});
