import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';

const AGENT_NAME = 'caesar';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const BAQS_DIR = path.join(AGENT_DIR, 'baqs');
const TASK_FILE = path.join(AGENT_DIR, 'current-task.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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

async function loadBAQIndex() {
  try {
    const files = await readdir(BAQS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const baqs = await Promise.all(
      jsonFiles.map(async (f) => {
        const content = await readFile(path.join(BAQS_DIR, f), 'utf-8');
        try {
          return { file: f, ...JSON.parse(content) };
        } catch {
          return { file: f, error: 'invalid JSON' };
        }
      })
    );
    return baqs;
  } catch {
    return [];
  }
}

async function callEpicorAPI(endpoint, params) {
  const baseUrl = process.env.EPICOR_BASE_URL;
  const apiKey = process.env.EPICOR_API_KEY;

  if (!baseUrl || !apiKey) {
    return { error: 'Epicor credentials not configured. See TODO.md.' };
  }

  const url = new URL(endpoint, baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v);
  }

  await log(`Epicor API call: ${url.pathname}${url.search}`);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    await log(`Epicor API response: ${response.status}`);
    return { status: response.status, data };
  } catch (err) {
    await log(`Epicor API error: ${err.message}`);
    return { error: err.message };
  }
}

async function processTask(task) {
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  const systemPrompt = await loadSystemPrompt();
  const baqIndex = await loadBAQIndex();

  const prompt = `${systemPrompt}

## Available BAQ Definitions
${JSON.stringify(baqIndex, null, 2)}

## Epicor Configuration
Base URL: ${process.env.EPICOR_BASE_URL || 'NOT CONFIGURED'}
API Key: ${process.env.EPICOR_API_KEY ? 'SET' : 'NOT CONFIGURED'}

## Current Task
${JSON.stringify(task, null, 2)}

Analyze the task and determine:
1. Which BAQ or Epicor endpoint to use
2. What parameters are needed
3. Provide the response plan

If credentials are not configured, explain what data would be returned once they are set up.`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  const output = {
    agent: AGENT_NAME,
    task_source: task._source_file || 'unknown',
    query: 'Gemini analysis (live Epicor calls pending credentials)',
    result: response,
    record_count: 0,
    completed_at: new Date().toISOString()
  };

  const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
  await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
  await writeFile(outFile, JSON.stringify(output, null, 2));
  await log(`Task complete. Output: ${outFile}`);
}

async function main() {
  await log('Caesar agent starting...');

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
