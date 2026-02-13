import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';

const AGENT_NAME = 'maggie';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const DRAFTS_DIR = path.join(AGENT_DIR, 'drafts');
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

async function loadReferenceFiles(files) {
  const contents = [];
  for (const filepath of (files || [])) {
    try {
      const content = await readFile(filepath, 'utf-8');
      contents.push(`## ${path.basename(filepath)}\n${content}`);
    } catch {
      contents.push(`## ${path.basename(filepath)}\n(file not found)`);
    }
  }
  return contents.join('\n\n---\n\n');
}

async function processTask(task) {
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  const systemPrompt = await loadSystemPrompt();
  const references = await loadReferenceFiles(task.reference_files);

  const prompt = `${systemPrompt}

## Reference Material
${references || '(no reference files provided)'}

## Current Task
${JSON.stringify(task, null, 2)}

Draft the communication as requested. Include a subject line. Match the tone to the audience. Output ONLY the draft content — no commentary.`;

  const result = await model.generateContent(prompt);
  const response = result.response.text();

  const draftFilename = `draft-${Date.now()}.txt`;
  const draftPath = path.join(DRAFTS_DIR, draftFilename);
  await mkdir(DRAFTS_DIR, { recursive: true });
  await writeFile(draftPath, response);

  // Extract subject line (first line if it starts with "Subject:")
  const firstLine = response.split('\n')[0];
  const subjectLine = firstLine.startsWith('Subject:') ? firstLine.replace('Subject:', '').trim() : '(see draft)';

  const summary = {
    agent: AGENT_NAME,
    task_source: task._source_file || 'unknown',
    draft_file: draftPath,
    audience: task.audience || 'unknown',
    subject_line: subjectLine,
    completed_at: new Date().toISOString()
  };

  const summaryFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
  await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));
  await log(`Task complete. Draft: ${draftPath}`);
}

async function main() {
  await log('Maggie agent starting...');

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
