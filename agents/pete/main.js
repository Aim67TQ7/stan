import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';

const AGENT_NAME = 'pete';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const INBOX = path.join(AGENT_DIR, 'inbox');
const OUTBOX = path.join(AGENT_DIR, 'outbox');
const VAULT = path.join(AGENT_DIR, 'vault');
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

async function listVaultContents() {
  try {
    const files = await readdir(VAULT);
    return files.length > 0 ? files.join(', ') : '(vault is empty)';
  } catch {
    return '(vault not accessible)';
  }
}

async function loadSourceFile(filepath) {
  try {
    return await readFile(filepath, 'utf-8');
  } catch {
    return null;
  }
}

async function processTask(task) {
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  const systemPrompt = await loadSystemPrompt();
  const vaultContents = await listVaultContents();

  let sourceContent = '';
  if (task.source_file) {
    const content = await loadSourceFile(task.source_file);
    if (content) {
      sourceContent = `\n## Source Document Content\n${content}`;
    } else {
      sourceContent = `\n## Source Document\nFile not found: ${task.source_file}`;
    }
  }

  const prompt = `${systemPrompt}

## Vault Contents
Available templates/assets: ${vaultContents}
${sourceContent}

## Current Task
${JSON.stringify(task, null, 2)}

Reconstruct or reformat the document as requested. Output the full document content.`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  const outputFilename = `reconstructed-${Date.now()}.txt`;
  const outputPath = path.join(OUTBOX, outputFilename);
  await mkdir(OUTBOX, { recursive: true });
  await writeFile(outputPath, response);

  const summary = {
    agent: AGENT_NAME,
    task_source: task._source_file || 'unknown',
    output_file: outputPath,
    changes_made: ['Document reconstructed via Gemini Flash 2.0'],
    completed_at: new Date().toISOString()
  };

  const summaryFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
  await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));
  await log(`Task complete. Output: ${outputPath}`);
}

async function main() {
  await log('Pete agent starting...');

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
