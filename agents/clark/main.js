import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import { watch } from 'chokidar';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { createServer } from 'http';
import cronParser from 'cron-parser';
import path from 'path';

const AGENT_NAME = 'clark';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const UPLOADS_DIR = path.join(AGENT_DIR, 'uploads');
const TASK_FILE = path.join(AGENT_DIR, 'current-task.json');
const STATUS_FILE = path.join(WORKSPACE, 'agent-status.json');

const WRITABLE_TABLES = ['tasks', 'agent_status', 'agent_activity', 'scheduled_tasks'];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

let supabase = null;

const startTime = Date.now();
let lastTaskAt = null;
let currentTask = null;
let loadedSkills = [];

function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

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

function startHealthServer() {
  createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agent: AGENT_NAME,
        status: 'ok',
        last_task_at: lastTaskAt,
        current_task: currentTask,
        api_key_valid: !!process.env.GEMINI_API_KEY,
        supabase_connected: !!supabase,
        loaded_skills: loadedSkills,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000)
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(3001, '0.0.0.0');
}

async function loadSystemPrompt() {
  return await readFile(path.join('/app', 'AGENT.md'), 'utf-8');
}

// --- Core DB Operations ---

async function queryTable(table, query) {
  if (!supabase) return { error: 'Supabase credentials not configured.' };

  await log(`READ: ${table} — ${JSON.stringify(query)}`);
  let req = supabase.from(table).select(query.select || '*');

  if (query.filter) {
    for (const [col, op, val] of query.filter) {
      req = req.filter(col, op, val);
    }
  }
  if (query.limit) req = req.limit(query.limit);
  if (query.order) req = req.order(query.order.column, { ascending: query.order.ascending ?? true });

  const { data, error } = await req;
  if (error) {
    await log(`READ ERROR: ${error.message}`);
    return { error: error.message };
  }
  return { data, count: data.length };
}

async function writeToTable(table, record) {
  if (!supabase) return { error: 'Supabase credentials not configured.' };
  if (!WRITABLE_TABLES.includes(table)) {
    await log(`WRITE DENIED: attempted write to '${table}'`);
    return { error: `DENIED: Write access to '${table}' not permitted. Writable: ${WRITABLE_TABLES.join(', ')}` };
  }

  await log(`WRITE: ${table} — ${JSON.stringify(record).slice(0, 200)}`);
  const { data, error } = await supabase.from(table).upsert(record).select();
  if (error) {
    await log(`WRITE ERROR [${table}]: ${error.message}`);
    return { error: error.message };
  }
  return { data };
}

async function uploadFile(filepath, bucket) {
  if (!supabase) return { error: 'Supabase credentials not configured.' };

  const filename = path.basename(filepath);
  const fileBuffer = await readFile(filepath);

  await log(`UPLOAD: ${bucket}/${filename}`);
  const { data, error } = await supabase.storage.from(bucket).upload(filename, fileBuffer, {
    contentType: 'application/pdf',
    upsert: true
  });

  if (error) {
    await log(`UPLOAD ERROR: ${error.message}`);
    return { error: error.message };
  }

  const uploadRecord = { bucket, filename, path: data.path, uploaded_at: new Date().toISOString() };
  const trackFile = path.join(UPLOADS_DIR, `${Date.now()}-${filename}.json`);
  await mkdir(UPLOADS_DIR, { recursive: true });
  await writeFile(trackFile, JSON.stringify(uploadRecord, null, 2));

  return { data };
}

// --- Activity Logging ---

async function logActivity(agentName, action, details = {}, userId = null, taskId = null) {
  if (!supabase) return;

  const record = {
    agent_name: agentName,
    action,
    details,
    user_id: userId || null,
    task_id: taskId || null
  };

  const { error } = await supabase.from('agent_activity').insert(record);
  if (error) {
    await log(`ACTIVITY LOG ERROR: ${error.message}`);
  }
}

// --- Agent Status Sync ---

async function syncAgentStatus(statusData) {
  if (!supabase) return;

  try {
    const agents = statusData.agents || {};
    const now = new Date().toISOString();

    for (const [agentName, health] of Object.entries(agents)) {
      const record = {
        agent_name: agentName,
        status: health.status || 'unknown',
        last_heartbeat: now,
        last_task_at: health.last_task_at || null,
        current_task: health.current_task || null,
        skills: health.loaded_skills || [],
        uptime_seconds: health.uptime_seconds || 0,
        updated_at: now
      };

      const { error } = await supabase.from('agent_status').upsert(record, { onConflict: 'agent_name' });
      if (error) {
        await log(`STATUS SYNC ERROR [${agentName}]: ${error.message}`);
      }
    }

    await log(`Status synced: ${Object.keys(agents).length} agents`);
  } catch (err) {
    await log(`Status sync failed: ${err.message}`);
  }
}

function watchAgentStatus() {
  const watcher = watch(STATUS_FILE, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 }
  });

  watcher.on('add', handleStatusChange);
  watcher.on('change', handleStatusChange);

  async function handleStatusChange() {
    try {
      const raw = await readFile(STATUS_FILE, 'utf-8');
      const statusData = JSON.parse(raw);
      await syncAgentStatus(statusData);
    } catch (err) {
      await log(`Status file read error: ${err.message}`);
    }
  }

  return watcher;
}

// --- Scheduled Tasks Scheduler ---

function computeNextRun(cronExpression) {
  try {
    const interval = cronParser.parseExpression(cronExpression);
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

async function pollScheduledTasks() {
  if (!supabase) return;

  try {
    const now = new Date().toISOString();
    const { data: dueTasks, error } = await supabase
      .from('scheduled_tasks')
      .select('*')
      .eq('enabled', true)
      .lte('next_run_at', now);

    if (error) {
      await log(`SCHEDULER ERROR: ${error.message}`);
      return;
    }

    if (!dueTasks || dueTasks.length === 0) return;

    await log(`Scheduler: ${dueTasks.length} due task(s)`);

    for (const scheduled of dueTasks) {
      const taskData = {
        id: scheduled.id,
        type: scheduled.task_type || 'general',
        description: scheduled.description || scheduled.title,
        assigned_to: scheduled.assigned_to || 'ANY',
        user_id: scheduled.user_id,
        payload: scheduled.payload || {},
        _source: 'scheduled-task',
        _schedule: scheduled.schedule,
        _scheduled_task_id: scheduled.id
      };

      const inboxDir = path.join(WORKSPACE, 'inbox');
      await mkdir(inboxDir, { recursive: true });
      const filename = `scheduled-${scheduled.id.slice(0, 8)}-${Date.now()}.json`;
      await writeFile(path.join(inboxDir, filename), JSON.stringify(taskData, null, 2));

      // Compute next run and update record
      const nextRun = computeNextRun(scheduled.schedule);
      await supabase.from('scheduled_tasks').update({
        last_run_at: now,
        next_run_at: nextRun,
        updated_at: now
      }).eq('id', scheduled.id);

      await logActivity(
        scheduled.assigned_to || 'system',
        'scheduled_task_dispatched',
        { scheduled_task_id: scheduled.id, title: scheduled.title, schedule: scheduled.schedule },
        scheduled.user_id
      );

      await log(`Scheduled task dispatched: ${scheduled.title} → inbox`);
    }
  } catch (err) {
    await log(`Scheduler error: ${err.message}`);
  }
}

function startScheduler() {
  pollScheduledTasks().catch(err => log(`Scheduler error: ${err.message}`));
  setInterval(() => {
    pollScheduledTasks().catch(err => log(`Scheduler error: ${err.message}`));
  }, 60000);
}

// --- Task Processing ---

async function processTask(task) {
  currentTask = task.description || task.type || 'unknown';
  lastTaskAt = new Date().toISOString();
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  try {
    let result;

    if (task.type === 'upload' && task.upload_file) {
      result = await uploadFile(task.upload_file, task.bucket || 'completed-pdfs');
    } else if (task.type === 'task-write' && task.record) {
      // Preserve user_id from the routed task if present
      if (task.user_id && !task.record.user_id) {
        task.record.user_id = task.user_id;
      }
      result = await writeToTable('tasks', task.record);
    } else if (task.type === 'log-activity') {
      await logActivity(
        task.agent_name || 'unknown',
        task.action || 'unknown',
        task.details || {},
        task.user_id || null,
        task.task_id || null
      );
      result = { logged: true };
    } else if (task.table) {
      const table = task.table;

      if (task.record) {
        // Preserve user_id from the routed task
        if (task.user_id && !task.record.user_id) {
          task.record.user_id = task.user_id;
        }
        result = await writeToTable(table, task.record);
      } else {
        result = await queryTable(table, task.query || {});
      }
    } else {
      const systemPrompt = await loadSystemPrompt();
      const prompt = `${systemPrompt}\n\n## Current Task\n${JSON.stringify(task, null, 2)}\n\nAnalyze the task and explain what Supabase operations would be needed. If credentials are not configured, explain what would happen once they are.`;
      const genResult = await model.generateContent(prompt);
      result = { analysis: genResult.response.text() };
    }

    // Log activity for completed tasks with user context
    if (task.user_id) {
      await logActivity(AGENT_NAME, 'task_completed', {
        type: task.type, description: (task.description || '').slice(0, 100)
      }, task.user_id, task.id || null);
    }

    const output = {
      agent: AGENT_NAME,
      task_source: task._source_file || 'unknown',
      operation: task.type || 'read',
      table: task.table || task.bucket || 'n/a',
      result,
      record_count: result.data ? (Array.isArray(result.data) ? result.data.length : 1) : 0,
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
  await log('Clark agent starting...');

  supabase = initSupabase();
  if (!supabase) {
    await log('WARNING: Supabase credentials not set. Running in dry-run mode.');
  } else {
    await log('Supabase client initialized.');
  }

  await loadSkills();
  startHealthServer();
  await log('Health server on :3001');

  // Watch agent-status.json for changes and sync to Supabase
  const statusWatcher = watchAgentStatus();
  await log('Watching agent-status.json for status sync');

  // Start scheduled tasks poller (every 60s)
  startScheduler();
  await log('Scheduled tasks poller started — checking every 60s');

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
    await statusWatcher.close();
    await watcher.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  await log(`Fatal: ${err.message}`);
  process.exit(1);
});
