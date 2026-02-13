import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import { watch } from 'chokidar';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const AGENT_NAME = 'clark';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const UPLOADS_DIR = path.join(AGENT_DIR, 'uploads');
const TASK_FILE = path.join(AGENT_DIR, 'current-task.json');

const WRITABLE_TABLES = ['tasks'];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

let supabase = null;

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

async function loadSystemPrompt() {
  return await readFile(path.join('/app', 'AGENT.md'), 'utf-8');
}

async function queryTable(table, query) {
  if (!supabase) return { error: 'Supabase credentials not configured. See TODO.md.' };

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

async function writeToTasks(record) {
  if (!supabase) return { error: 'Supabase credentials not configured. See TODO.md.' };

  await log(`WRITE: tasks — ${JSON.stringify(record)}`);
  const { data, error } = await supabase.from('tasks').upsert(record).select();
  if (error) {
    await log(`WRITE ERROR: ${error.message}`);
    return { error: error.message };
  }
  return { data };
}

async function uploadFile(filepath, bucket) {
  if (!supabase) return { error: 'Supabase credentials not configured. See TODO.md.' };

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

  // Track upload locally
  const uploadRecord = { bucket, filename, path: data.path, uploaded_at: new Date().toISOString() };
  const trackFile = path.join(UPLOADS_DIR, `${Date.now()}-${filename}.json`);
  await mkdir(UPLOADS_DIR, { recursive: true });
  await writeFile(trackFile, JSON.stringify(uploadRecord, null, 2));

  return { data };
}

async function processTask(task) {
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  let result;

  if (task.type === 'upload' && task.upload_file) {
    result = await uploadFile(task.upload_file, task.bucket || 'completed-pdfs');
  } else if (task.type === 'task-write' && task.record) {
    result = await writeToTasks(task.record);
  } else if (task.table) {
    const table = task.table;

    if (task.record && !WRITABLE_TABLES.includes(table)) {
      result = { error: `DENIED: Write access to '${table}' is not permitted. Writable tables: ${WRITABLE_TABLES.join(', ')}` };
      await log(`WRITE DENIED: attempted write to '${table}'`);
    } else if (task.record) {
      result = await writeToTasks(task.record);
    } else {
      result = await queryTable(table, task.query || {});
    }
  } else {
    // Fall back to Gemini for analysis/planning
    const systemPrompt = await loadSystemPrompt();
    const prompt = `${systemPrompt}\n\n## Current Task\n${JSON.stringify(task, null, 2)}\n\nAnalyze the task and explain what Supabase operations would be needed. If credentials are not configured, explain what would happen once they are.`;
    const genResult = await model.generateContent(prompt);
    result = { analysis: genResult.response.text() };
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
}

async function main() {
  await log('Clark agent starting...');

  supabase = initSupabase();
  if (!supabase) {
    await log('WARNING: Supabase credentials not set. Running in dry-run mode.');
  } else {
    await log('Supabase client initialized.');
  }

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
    await watcher.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  await log(`Fatal: ${err.message}`);
  process.exit(1);
});
