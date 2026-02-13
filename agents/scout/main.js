import { GoogleGenerativeAI } from '@google/generative-ai';
import { watch } from 'chokidar';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import { createServer } from 'http';
import path from 'path';

const AGENT_NAME = 'scout';
const AGENT_DIR = '/app/agent';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const CACHE_DIR = path.join(AGENT_DIR, 'cache');
const TASK_FILE = path.join(AGENT_DIR, 'current-task.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use grounded model for web search capability
const searchModel = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  tools: [{ googleSearch: {} }]
});

// Plain model for synthesis
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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

function cacheKey(query) {
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
}

async function getCached(query) {
  const key = cacheKey(query);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const raw = await readFile(file, 'utf-8');
    const cached = JSON.parse(raw);
    const age = Date.now() - new Date(cached.cached_at).getTime();
    // Cache valid for 24 hours
    if (age < 86400000) {
      await log(`Cache hit: ${key}`);
      return cached;
    }
  } catch {}
  return null;
}

async function setCache(query, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = cacheKey(query);
  const file = path.join(CACHE_DIR, `${key}.json`);
  const cached = { ...data, cached_at: new Date().toISOString(), query };
  await writeFile(file, JSON.stringify(cached, null, 2));
}

async function webSearch(query) {
  const cached = await getCached(query);
  if (cached) return cached.result;

  await log(`Searching: ${query}`);

  const result = await searchModel.generateContent(
    `Search the web and provide a comprehensive answer with sources for: ${query}\n\nInclude URLs for all sources cited.`
  );
  const response = result.response.text();

  // Extract grounding metadata if available
  const sources = [];
  const groundingMetadata = result.response.candidates?.[0]?.groundingMetadata;
  if (groundingMetadata?.groundingChunks) {
    for (const chunk of groundingMetadata.groundingChunks) {
      if (chunk.web?.uri) {
        sources.push(chunk.web.uri);
      }
    }
  }

  const searchResult = { result: response, sources };
  await setCache(query, searchResult);
  return response;
}

async function processTask(task) {
  const description = task.description || task.message || '';
  currentTask = description.slice(0, 100) || task.type || 'unknown';
  lastTaskAt = new Date().toISOString();
  await log(`Processing research task: ${description.slice(0, 100)}`);

  try {
    const systemPrompt = await loadSystemPrompt();

    // Step 1: Web search with grounding
    let searchResults;
    try {
      searchResults = await webSearch(description);
    } catch (err) {
      await log(`Search failed: ${err.message}, falling back to model knowledge`);
      searchResults = null;
    }

    // Step 2: Synthesize into structured report
    const synthesisPrompt = `${systemPrompt}

## Research Task
${JSON.stringify(task, null, 2)}

## Web Search Results
${searchResults || '(Search unavailable — use your training knowledge and note the limitation)'}

Synthesize the above into a structured markdown research report following the format in your AGENT.md. Be thorough, cite sources, and rate your confidence.`;

    const result = await model.generateContent(synthesisPrompt);
    const report = result.response.text();

    // Extract source URLs from the report
    const urlPattern = /https?:\/\/[^\s)>\]]+/g;
    const sources = [...new Set((report.match(urlPattern) || []))];

    const confidence = report.toLowerCase().includes('confidence: high') ? 'high'
      : report.toLowerCase().includes('confidence: low') ? 'low'
      : 'medium';

    const output = {
      agent: AGENT_NAME,
      task_source: task._source_file || 'unknown',
      result: report,
      sources,
      confidence,
      completed_at: new Date().toISOString()
    };

    const outFile = path.join(WORKSPACE, 'outbox', `${AGENT_NAME}-${Date.now()}.json`);
    await mkdir(path.join(WORKSPACE, 'outbox'), { recursive: true });
    await writeFile(outFile, JSON.stringify(output, null, 2));
    await log(`Research complete. Output: ${outFile}`);
  } finally {
    currentTask = null;
  }
}

async function main() {
  await log('Scout agent starting...');
  await mkdir(CACHE_DIR, { recursive: true });
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
