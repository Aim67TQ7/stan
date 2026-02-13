import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';

const AGENT_NAME = 'magnus';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const KNOWLEDGE_DIR = path.join(AGENT_DIR, 'knowledge');
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
  const agentMd = await readFile(path.join('/app', 'AGENT.md'), 'utf-8');
  return agentMd;
}

async function loadKnowledge() {
  try {
    const files = await readdir(KNOWLEDGE_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const contents = await Promise.all(
      mdFiles.map(async (f) => {
        const content = await readFile(path.join(KNOWLEDGE_DIR, f), 'utf-8');
        return `## ${f}\n${content}`;
      })
    );
    return contents.join('\n\n---\n\n');
  } catch {
    return '(No knowledge files found)';
  }
}

async function processTask(task) {
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  const systemPrompt = await loadSystemPrompt();
  const knowledge = await loadKnowledge();

  const prompt = `${systemPrompt}

## Available Knowledge Base
${knowledge}

## Current Task
${JSON.stringify(task, null, 2)}

Provide a thorough, accurate response based on the knowledge base. If the knowledge base does not contain the answer, state that clearly.`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  const output = {
    agent: AGENT_NAME,
    task_source: task._source_file || 'unknown',
    result: response,
    sources: [],
    confidence: 'medium',
    completed_at: new Date().toISOString()
  };

  const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
  await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
  await writeFile(outFile, JSON.stringify(output, null, 2));
  await log(`Task complete. Output: ${outFile}`);
}

async function main() {
  await log('Magnus agent starting...');

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
