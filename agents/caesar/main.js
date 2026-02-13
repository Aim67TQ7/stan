import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { createServer } from 'http';
import path from 'path';

const AGENT_NAME = 'caesar';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const BAQS_DIR = path.join(AGENT_DIR, 'baqs');
const TASK_FILE = path.join(AGENT_DIR, 'current-task.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Epicor config
const EPICOR_BASE_URL = process.env.EPICOR_BASE_URL;
const EPICOR_API_KEY = process.env.EPICOR_API_KEY;
const EPICOR_USERNAME = process.env.EPICOR_USERNAME;
const EPICOR_PASSWORD = process.env.EPICOR_PASSWORD;
const EPICOR_COMPANIES = (process.env.EPICOR_COMPANIES || '').split(',').filter(Boolean);
const DEFAULT_COMPANY = EPICOR_COMPANIES[0] || 'BMC';

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
        epicor_configured: epicorConfigured(),
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

function epicorConfigured() {
  return !!(EPICOR_BASE_URL && EPICOR_API_KEY && EPICOR_USERNAME && EPICOR_PASSWORD);
}

function buildAuthHeaders(company) {
  const basicAuth = Buffer.from(`${EPICOR_USERNAME}:${EPICOR_PASSWORD}`).toString('base64');
  return {
    'Authorization': `Basic ${basicAuth}`,
    'x-api-key': EPICOR_API_KEY,
    'Content-Type': 'application/json',
    'CallSettings': JSON.stringify({ Company: company || DEFAULT_COMPANY })
  };
}

async function callEpicorAPI(endpoint, { params, company, method = 'GET', body } = {}) {
  if (!epicorConfigured()) {
    return { error: 'Epicor credentials not configured. Need EPICOR_BASE_URL, EPICOR_API_KEY, EPICOR_USERNAME, EPICOR_PASSWORD.' };
  }

  const resolvedCompany = company || DEFAULT_COMPANY;
  if (!EPICOR_COMPANIES.includes(resolvedCompany)) {
    return { error: `Invalid company "${resolvedCompany}". Valid: ${EPICOR_COMPANIES.join(', ')}` };
  }

  const url = new URL(endpoint, EPICOR_BASE_URL);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v);
  }

  await log(`Epicor API ${method} [${resolvedCompany}]: ${url.pathname}${url.search}`);

  try {
    const fetchOpts = {
      method,
      headers: buildAuthHeaders(resolvedCompany)
    };
    if (body && method !== 'GET') {
      fetchOpts.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), fetchOpts);
    const data = await response.json();
    await log(`Epicor API response: ${response.status} [${resolvedCompany}]`);
    return { status: response.status, company: resolvedCompany, data };
  } catch (err) {
    await log(`Epicor API error [${resolvedCompany}]: ${err.message}`);
    return { error: err.message, company: resolvedCompany };
  }
}

async function processTask(task) {
  currentTask = task.description || task.type || 'unknown';
  lastTaskAt = new Date().toISOString();
  await log(`Processing task: ${task.type || 'unknown'} — ${task.description || ''}`);

  try {
    const systemPrompt = await loadSystemPrompt();
    const baqIndex = await loadBAQIndex();

    const prompt = `${systemPrompt}

## Available BAQ Definitions
${JSON.stringify(baqIndex, null, 2)}

## Epicor Configuration
Base URL: ${EPICOR_BASE_URL || 'NOT CONFIGURED'}
Auth: ${epicorConfigured() ? 'Basic Auth + API Key CONFIGURED' : 'NOT CONFIGURED'}
Companies: ${EPICOR_COMPANIES.length ? EPICOR_COMPANIES.join(', ') : 'NOT CONFIGURED'}
Default Company: ${DEFAULT_COMPANY}

## Current Task
${JSON.stringify(task, null, 2)}

Analyze the task and determine:
1. Which BAQ or Epicor endpoint to use
2. Which company code to target (BMC, BME, or MAI) — default to ${DEFAULT_COMPANY} if not specified
3. What parameters are needed
4. Provide the response plan

If credentials are not configured, explain what data would be returned once they are set up.`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    const output = {
      agent: AGENT_NAME,
      task_source: task._source_file || 'unknown',
      company: task.company || DEFAULT_COMPANY,
      query: epicorConfigured() ? 'Gemini analysis + Epicor live' : 'Gemini analysis (Epicor credentials pending)',
      result: response,
      record_count: 0,
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
  await log('Caesar agent starting...');
  await log(`Companies: ${EPICOR_COMPANIES.join(', ') || 'NONE'} | Default: ${DEFAULT_COMPANY}`);
  await log(`Epicor auth: ${epicorConfigured() ? 'OK' : 'MISSING CREDENTIALS'}`);
  await loadSkills();
  startHealthServer();
  await log('Health server on :3001');

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
