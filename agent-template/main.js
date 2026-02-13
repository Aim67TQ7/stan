import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const AGENT_NAME = 'AGENT_NAME';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
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

async function processTask(task) {
  await log(`Processing task: ${task.type || 'unknown'} — ${(task.description || '').slice(0, 100)}`);

  const systemPrompt = await loadSystemPrompt();

  const prompt = `${systemPrompt}

## Current Task
${JSON.stringify(task, null, 2)}

Provide a thorough, accurate response. If you cannot complete the task, explain why clearly.`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  const output = {
    agent: AGENT_NAME,
    task_source: task._source_file || 'unknown',
    result: response,
    completed_at: new Date().toISOString()
  };

  const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
  await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
  await writeFile(outFile, JSON.stringify(output, null, 2));
  await log(`Task complete. Output: ${outFile}`);
}

async function main() {
  await log(`${AGENT_NAME} agent starting...`);

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
