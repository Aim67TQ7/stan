import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
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

let supabase = null;

function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

const activeCrons = [];

const startTime = Date.now();
let lastTaskAt = null;
let currentTask = null;
let loadedSkills = [];

async function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${AGENT_NAME}] ${message}\n`;
  const logFile = path.join(LOGS, `${AGENT_NAME}-${timestamp.split('T')[0]}.log`);
  await writeFile(logFile, entry, { flag: 'a' }).catch(() => {});
  console.log(entry.trim());
}

async function loadSkills() {
  try {
    const registry = JSON.parse(await readFile('/app/skills/registry.json', 'utf-8'));
    loadedSkills = registry.agents[AGENT_NAME]?.skills || [];
  } catch { loadedSkills = []; }
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

// Map agent names to orchestrator-routable task types
const AGENT_TYPE_MAP = {
  MAGNUS: 'equipment',
  PETE: 'document',
  CAESAR: 'epicor',
  MAGGIE: 'email',
  CLARK: 'supabase',
  SENTRY: 'webhook',
  SCOUT: 'research',
  ORACLE: 'complex'
};

async function dropTaskToInbox(taskData) {
  const inboxDir = path.join(WORKSPACE, 'inbox');
  await mkdir(inboxDir, { recursive: true });
  const filename = `sentry-${Date.now()}.json`;
  await writeFile(path.join(inboxDir, filename), JSON.stringify(taskData, null, 2));
  await log(`Task dropped to inbox: ${filename}`);
}

function buildTaskData(record, source) {
  const assignedTo = (record.assigned_to || 'ANY').toUpperCase();
  return {
    id: record.id,
    type: AGENT_TYPE_MAP[assignedTo] || record.type || 'general',
    description: record.description || record.title || '',
    priority: record.priority || 'normal',
    assigned_to: assignedTo,
    user_id: record.user_id || null,
    supabase_record: record,
    _source: source,
    _received_at: new Date().toISOString()
  };
}

async function markInProgress(taskId) {
  if (!supabase || !taskId) return;
  const { error } = await supabase
    .from('tasks')
    .update({ status: 'in_progress' })
    .eq('id', taskId);
  if (error) {
    await log(`Failed to mark ${taskId} in_progress: ${error.message}`);
  }
}

// --- Supabase Inbox Poller ---

async function pollInboxTasks() {
  if (!supabase) return;

  try {
    const { data: tasks, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('status', 'inbox');

    if (error) {
      await log(`POLLER ERROR: ${error.message}`);
      return;
    }

    if (!tasks || tasks.length === 0) return;

    await log(`POLLER: Found ${tasks.length} inbox task(s)`);

    for (const record of tasks) {
      const taskData = buildTaskData(record, 'supabase-poller');
      await dropTaskToInbox(taskData);
      await markInProgress(record.id);
      await log(`POLLER: Task ${record.id} → inbox, marked in_progress`);
    }
  } catch (err) {
    await log(`POLLER error: ${err.message}`);
  }
}

function startInboxPoller() {
  // Run immediately on startup to catch anything waiting
  pollInboxTasks().catch(err => log(`Poller error: ${err.message}`));
  setInterval(() => {
    pollInboxTasks().catch(err => log(`Poller error: ${err.message}`));
  }, 30000);
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

  // Supabase tasks table webhook — extracts record and builds routable task
  app.post('/hook/new-task', async (req, res) => {
    const payload = req.body;
    await log(`Supabase new-task webhook: ${JSON.stringify(payload).slice(0, 300)}`);

    const record = payload.record;
    if (!record) {
      await log('new-task webhook: no record in payload');
      return res.status(400).json({ status: 'error', message: 'No record in payload' });
    }

    const taskData = buildTaskData(record, 'supabase-webhook');
    await dropTaskToInbox(taskData);
    await markInProgress(record.id);
    await log(`Supabase task ${record.id} → inbox (assigned_to: ${taskData.assigned_to}), marked in_progress`);

    res.json({ status: 'accepted', task_id: record.id });
  });

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

  // --- Direct Chat with STAN ---
  app.post('/chat/stan', async (req, res) => {
    const { message, user_id } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    await log(`CHAT: user=${user_id || 'anon'} — ${message.slice(0, 200)}`);

    try {
      const chatPrompt = `You are STAN (Strategic Tactical Autonomous Node), an AI operations assistant for Bunting Magnetics. You are helpful, concise, and action-oriented. You speak like Radar O'Reilly — you anticipate needs and stay efficient.

You have these agents available:
- Magnus: equipment/technical knowledge about Bunting Magnetics products
- Pete: document reconstruction and formatting
- Caesar: Epicor ERP — orders, customers, BAQs
- Maggie: drafting emails, letters, communications
- Clark: Supabase database operations
- Scout: web research and investigation
- Oracle: complex reasoning, code review, architecture
- Sentry: webhooks and scheduling

If the user's message is a TASK (they want something done, created, looked up, drafted, etc.), respond with JSON:
{"is_task": true, "response": "Brief confirmation of what you're doing", "task": {"type": "keyword", "description": "full task description", "assigned_to": "AGENT_NAME", "priority": "normal"}}

If the user's message is CONVERSATION (greeting, question about STAN, general chat), respond with JSON:
{"is_task": false, "response": "Your conversational response"}

User message: ${message}

JSON response:`;

      const result = await model.generateContent(chatPrompt);
      const rawResponse = result.response.text();

      // Parse the JSON response from Gemini
      let parsed;
      try {
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponse);
      } catch {
        parsed = { is_task: false, response: rawResponse };
      }

      // If STAN determined this is a task, create it and route it
      if (parsed.is_task && parsed.task) {
        const taskRecord = {
          type: parsed.task.type || 'general',
          description: parsed.task.description || message,
          assigned_to: (parsed.task.assigned_to || 'ANY').toUpperCase(),
          priority: parsed.task.priority || 'normal',
          user_id: user_id || null,
          _source: 'chat'
        };

        // If Supabase is available, create the task there (triggers the pipeline)
        if (supabase && user_id) {
          const { data, error } = await supabase.from('tasks').insert({
            title: parsed.task.description?.slice(0, 100) || message.slice(0, 100),
            description: parsed.task.description || message,
            assigned_to: taskRecord.assigned_to,
            priority: taskRecord.priority,
            status: 'inbox',
            user_id
          }).select().single();

          if (!error && data) {
            taskRecord.id = data.id;
            await log(`CHAT: Created Supabase task ${data.id} for user ${user_id}`);
          }
        }

        // Also drop directly to inbox for immediate processing
        const taskData = buildTaskData({
          ...taskRecord,
          id: taskRecord.id || `chat-${Date.now()}`
        }, 'chat');
        await dropTaskToInbox(taskData);

        if (taskRecord.id) {
          await markInProgress(taskRecord.id);
        }

        await log(`CHAT: Task routed → ${taskRecord.assigned_to}: ${taskRecord.description?.slice(0, 80)}`);

        res.json({
          response: parsed.response,
          task_created: true,
          task_id: taskRecord.id || null,
          assigned_to: taskRecord.assigned_to
        });
      } else {
        res.json({
          response: parsed.response,
          task_created: false
        });
      }
    } catch (err) {
      await log(`CHAT ERROR: ${err.message}`);
      res.status(500).json({ error: 'STAN encountered an error processing your message.' });
    }
  });

  // Health endpoint with full status
  app.get('/health', (req, res) => {
    res.json({
      agent: AGENT_NAME,
      status: 'ok',
      last_task_at: lastTaskAt,
      current_task: currentTask,
      api_key_valid: !!process.env.GEMINI_API_KEY,
      supabase_connected: !!supabase,
      loaded_skills: loadedSkills,
      active_crons: activeCrons.length,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000)
    });
  });

  app.listen(3000, '0.0.0.0', () => {
    log('Webhook server listening on :3000');
  });
}

async function processTask(task) {
  currentTask = task.description || task.type || 'unknown';
  lastTaskAt = new Date().toISOString();
  await log(`Processing direct task: ${task.type || 'unknown'} — ${task.description || ''}`);

  try {
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
  } finally {
    currentTask = null;
  }
}

async function main() {
  await log('Sentry agent starting...');
  await loadSkills();

  supabase = initSupabase();
  if (supabase) {
    await log('Supabase client initialized — inbox poller enabled');
  } else {
    await log('WARNING: Supabase credentials not set — inbox poller disabled');
  }

  // Load webhook handlers and start HTTP server
  const handlers = await loadHookHandlers();
  startWebhookServer(handlers);

  // Load and schedule cron jobs
  await loadAndScheduleCrons();

  // Start polling Supabase for inbox tasks every 30s
  startInboxPoller();
  await log('Inbox poller started — checking every 30s');

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
