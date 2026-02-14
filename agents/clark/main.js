import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { watch } from 'chokidar';
import { readFile, writeFile, mkdir, rename, readdir, stat } from 'fs/promises';
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
const OUTBOX_DIR = path.join(WORKSPACE, 'outbox');
const PROCESSED_DIR = path.join(OUTBOX_DIR, 'processed');
const INBOX_PROCESSED_DIR = path.join(WORKSPACE, 'processed');

const WRITABLE_TABLES = ['tasks', 'agent_status', 'agent_activity', 'scheduled_tasks', 'chat_messages'];

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

async function logUsage(taskType, usage, durationMs) {
  const usageFile = path.join(LOGS, `usage-${AGENT_NAME}-${new Date().toISOString().split('T')[0]}.jsonl`);
  const record = {
    timestamp: new Date().toISOString(),
    agent: AGENT_NAME,
    task_type: taskType,
    prompt_tokens: usage?.prompt_tokens || 0,
    completion_tokens: usage?.completion_tokens || 0,
    total_tokens: usage?.total_tokens || 0,
    duration_ms: durationMs
  };
  await writeFile(usageFile, JSON.stringify(record) + '\n', { flag: 'a' }).catch(() => {});
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
        api_key_valid: !!process.env.GROQ_API_KEY,
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
        agent_name: agentName.toUpperCase(),
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

// --- Outbox Watcher (sync results back to Supabase) ---

async function resolveTaskContext(result) {
  const ctx = { taskId: null, conversationId: null, userId: null, source: null };

  // 1. Direct task_id in result
  if (result.task_id) ctx.taskId = result.task_id;

  // 2. Look up the processed inbox file by task_source filename
  const sourceFile = result.task_source;
  if (sourceFile && sourceFile !== 'unknown') {
    try {
      const raw = await readFile(path.join(INBOX_PROCESSED_DIR, sourceFile), 'utf-8');
      const task = JSON.parse(raw);
      if (!ctx.taskId) ctx.taskId = task.id || null;
      ctx.conversationId = task._conversation_id || null;
      ctx.userId = task.user_id || null;
      ctx.source = task._source || null;
    } catch {}
  }

  return ctx;
}

// Backward compat wrapper
async function resolveTaskId(result) {
  const ctx = await resolveTaskContext(result);
  return ctx.taskId;
}

const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function detectDeliverableType(ext) {
  if (['.pdf'].includes(ext)) return 'pdf';
  if (['.mp3', '.wav', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) return 'image';
  if (['.csv', '.xlsx', '.docx', '.txt', '.md', '.html'].includes(ext)) return 'document';
  return 'file';
}

async function uploadDeliverable(filepath, bucket = 'deliverables') {
  if (!supabase) return null;

  const filename = path.basename(filepath);
  const ext = path.extname(filename).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const deliverableType = detectDeliverableType(ext);

  try {
    const fileBuffer = await readFile(filepath);
    const storagePath = `${Date.now()}-${filename}`;

    const { data, error } = await supabase.storage.from(bucket).upload(storagePath, fileBuffer, {
      contentType,
      upsert: true
    });

    if (error) {
      await log(`DELIVERABLE UPLOAD ERROR: ${error.message}`);
      return null;
    }

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);

    await log(`DELIVERABLE: Uploaded ${filename} → ${bucket}/${storagePath}`);
    return {
      type: deliverableType,
      url: urlData.publicUrl,
      filename,
      content_type: contentType,
      storage_path: `${bucket}/${storagePath}`
    };
  } catch (err) {
    await log(`DELIVERABLE UPLOAD FAILED: ${err.message}`);
    return null;
  }
}

async function processOutboxFile(filepath) {
  if (!supabase) return;

  const filename = path.basename(filepath);

  // Skip clark's own output files to avoid feedback loops
  if (filename.startsWith('clark-')) return;

  try {
    const raw = await readFile(filepath, 'utf-8');
    const result = JSON.parse(raw);

    const taskCtx = await resolveTaskContext(result);
    const taskId = taskCtx.taskId;

    if (!taskId) {
      await log(`OUTBOX: No task ID found for ${filename} — skipping Supabase update`);
    } else {
      // Fetch existing task to append to updates array
      const { data: existing, error: fetchErr } = await supabase
        .from('tasks')
        .select('updates')
        .eq('id', taskId)
        .single();

      if (fetchErr) {
        await log(`OUTBOX: Failed to fetch task ${taskId}: ${fetchErr.message}`);
      } else {
        const updates = existing?.updates || [];

        // Build the update entry
        const updateEntry = {
          agent: result.agent,
          result: typeof result.result === 'string' ? result.result.slice(0, 4000) : result.result,
          confidence: result.confidence || null,
          sources: result.sources || null,
          completed_at: result.completed_at || new Date().toISOString(),
          deliverable: null
        };

        // Check for file deliverables — output_file or file_path in result
        const filePath = result.output_file || result.file_path ||
          (typeof result.result === 'object' && result.result?.file_path) || null;

        if (filePath) {
          try {
            await stat(filePath);
            const deliverable = await uploadDeliverable(filePath);
            if (deliverable) {
              updateEntry.deliverable = deliverable;
              await log(`OUTBOX: Deliverable attached — ${deliverable.type}: ${deliverable.url}`);
            }
          } catch {
            // File doesn't exist in container — may be a host path reference
            await log(`OUTBOX: Deliverable file not accessible: ${filePath}`);
          }
        }

        // If result itself is text content, mark as text deliverable
        if (!updateEntry.deliverable && typeof result.result === 'string' && result.result.length > 0) {
          updateEntry.deliverable = { type: 'text', content: result.result.slice(0, 8000) };
        }

        updates.push(updateEntry);

        const { error: updateErr } = await supabase
          .from('tasks')
          .update({ updates, status: 'done' })
          .eq('id', taskId);

        if (updateErr) {
          await log(`OUTBOX: Failed to update task ${taskId}: ${updateErr.message}`);
        } else {
          await log(`OUTBOX: Task ${taskId} updated — status=done, ${updates.length} update(s), deliverable=${updateEntry.deliverable?.type || 'none'}`);
        }

        // If this task came from chat, write the agent's response as a chat message
        if (taskCtx.conversationId && taskCtx.userId) {
          const agentContent = typeof result.result === 'string'
            ? result.result.slice(0, 8000)
            : JSON.stringify(result.result).slice(0, 8000);

          const { error: chatErr } = await supabase.from('chat_messages').insert({
            user_id: taskCtx.userId,
            conversation_id: taskCtx.conversationId,
            role: 'agent',
            content: agentContent,
            agent: result.agent || 'unknown',
            task_id: taskId,
            metadata: {
              deliverable: updateEntry.deliverable,
              confidence: result.confidence || null
            }
          });

          if (chatErr) {
            await log(`OUTBOX CHAT: Failed to write chat message: ${chatErr.message}`);
          } else {
            await log(`OUTBOX CHAT: Agent response written to chat — conv=${taskCtx.conversationId.slice(0, 8)}, agent=${result.agent}`);
          }
        }
      }
    }

    // Move to processed regardless (so we don't reprocess)
    await mkdir(PROCESSED_DIR, { recursive: true });
    await rename(filepath, path.join(PROCESSED_DIR, filename));
    await log(`OUTBOX: ${filename} → processed/`);
  } catch (err) {
    await log(`OUTBOX ERROR [${filename}]: ${err.message}`);
  }
}

async function processExistingOutbox() {
  try {
    const files = await readdir(OUTBOX_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) return;

    await log(`OUTBOX: Found ${jsonFiles.length} existing file(s) to process`);
    for (const f of jsonFiles) {
      await processOutboxFile(path.join(OUTBOX_DIR, f));
    }
  } catch (err) {
    await log(`OUTBOX: Error scanning existing files: ${err.message}`);
  }
}

function watchOutbox() {
  const watcher = watch(OUTBOX_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: [/processed\//, /^\./]
  });

  watcher.on('add', async (filepath) => {
    if (!filepath.endsWith('.json')) return;
    // Ignore files inside processed/ subdirectory
    if (filepath.includes('/processed/')) return;
    await processOutboxFile(filepath);
  });

  return watcher;
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
      const _taskStart = Date.now();
      const systemPrompt = await loadSystemPrompt();
      const prompt = `${systemPrompt}\n\n## Current Task\n${JSON.stringify(task, null, 2)}\n\nAnalyze the task and explain what Supabase operations would be needed. If credentials are not configured, explain what would happen once they are.`;
      const genResult = await groq.chat.completions.create({ messages: [{ role: 'user', content: prompt }], model: 'llama-3.3-70b-versatile' });
      const _usage = genResult.usage;
      await logUsage(task.type || 'unknown', _usage, Date.now() - _taskStart);
      result = { analysis: genResult.choices[0]?.message?.content || '', usage: _usage || null };
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

  // Process any existing outbox files, then watch for new ones
  await processExistingOutbox();
  const outboxWatcher = watchOutbox();
  await log('Watching workspace/outbox/ for agent results');

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
    await outboxWatcher.close();
    await watcher.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  await log(`Fatal: ${err.message}`);
  process.exit(1);
});
