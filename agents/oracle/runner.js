#!/usr/bin/env node

/**
 * ORACLE Runner — Host-side watcher that picks up tasks routed to ORACLE
 * and executes them via the claude CLI. NOT a Docker container.
 *
 * Usage: node /opt/stan/agents/oracle/runner.js
 */

import { watch } from 'chokidar';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const exec = promisify(execFile);

const ORACLE_DIR = path.dirname(new URL(import.meta.url).pathname);
const TASK_FILE = path.join(ORACLE_DIR, 'current-task.json');
const OUTBOX = path.resolve(ORACLE_DIR, '../../workspace/outbox');
const LOGS_DIR = path.join(ORACLE_DIR, 'logs');
const TOKEN_WARN_THRESHOLD = 10000;

async function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  const logFile = path.join(LOGS_DIR, `oracle-${new Date().toISOString().split('T')[0]}.log`);
  await writeFile(logFile, entry, { flag: 'a' }).catch(() => {});
  console.log(entry.trim());
}

async function logUsage(task, result, durationMs) {
  const usageFile = path.join(LOGS_DIR, `usage-${new Date().toISOString().split('T')[0]}.jsonl`);
  const record = {
    timestamp: new Date().toISOString(),
    task_type: task.type || 'unknown',
    source_file: task._source_file || 'unknown',
    duration_ms: durationMs,
    output_tokens: result?.usage?.output_tokens || null,
    input_tokens: result?.usage?.input_tokens || null,
    token_warning: (result?.usage?.output_tokens || 0) > TOKEN_WARN_THRESHOLD
  };
  await writeFile(usageFile, JSON.stringify(record) + '\n', { flag: 'a' }).catch(() => {});
}

function buildPrompt(task) {
  // Include all context the caller packed into the task
  const parts = [];

  if (task.system) parts.push(task.system);
  if (task.context) parts.push(`Context:\n${task.context}`);
  if (task.description) parts.push(`Task:\n${task.description}`);
  if (task.instructions) parts.push(`Instructions:\n${task.instructions}`);

  // Fallback: dump the whole task if nothing structured was provided
  if (parts.length === 0) {
    parts.push(JSON.stringify(task, null, 2));
  }

  return parts.join('\n\n');
}

async function executeOracle(task) {
  const prompt = buildPrompt(task);
  const startTime = Date.now();

  await log(`Executing ORACLE task: ${task.type || 'unknown'} from ${task._source_file || 'direct'}`);

  try {
    const { stdout } = await exec('claude', ['-p', prompt, '--output-format', 'json'], {
      timeout: 300000, // 5 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      env: { ...process.env }
    });

    const durationMs = Date.now() - startTime;
    let result;

    try {
      result = JSON.parse(stdout);
    } catch {
      // claude CLI returned non-JSON — wrap it
      result = { result: stdout.trim(), _raw: true };
    }

    // Token budget guard
    const outputTokens = result?.usage?.output_tokens || 0;
    if (outputTokens > TOKEN_WARN_THRESHOLD) {
      await log(`WARNING: ORACLE output exceeded ${TOKEN_WARN_THRESHOLD} token budget — used ${outputTokens} output tokens`);
    }

    await logUsage(task, result, durationMs);
    await log(`ORACLE completed in ${durationMs}ms`);

    return {
      _agent: 'oracle',
      _model: 'claude-opus-4-6',
      _completed_at: new Date().toISOString(),
      _duration_ms: durationMs,
      _source_file: task._source_file,
      _task_type: task.type || 'unknown',
      _output_tokens: outputTokens,
      result: result.result || result
    };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    await log(`ORACLE execution failed after ${durationMs}ms: ${err.message}`);
    await logUsage(task, null, durationMs);

    return {
      _agent: 'oracle',
      _error: err.message,
      _completed_at: new Date().toISOString(),
      _duration_ms: durationMs,
      _source_file: task._source_file,
      _task_type: task.type || 'unknown',
      _status: 'failed'
    };
  }
}

async function processTask(filepath) {
  try {
    const raw = await readFile(filepath, 'utf-8');
    const task = JSON.parse(raw);

    const result = await executeOracle(task);

    // Write result to outbox
    const outFile = path.join(OUTBOX, `oracle-${Date.now()}.json`);
    await writeFile(outFile, JSON.stringify(result, null, 2));
    await log(`Result written to ${path.basename(outFile)}`);

    // Remove the consumed task file
    await unlink(filepath).catch(() => {});

  } catch (err) {
    await log(`Error processing task file: ${err.message}`);
  }
}

async function main() {
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(OUTBOX, { recursive: true });

  await log('ORACLE runner starting — watching for tasks...');

  const watcher = watch(TASK_FILE, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });

  watcher.on('add', processTask);
  watcher.on('change', processTask);

  process.on('SIGTERM', async () => {
    await log('ORACLE runner shutting down');
    await watcher.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await log('ORACLE runner interrupted');
    await watcher.close();
    process.exit(0);
  });
}

main().catch(async (err) => {
  await log(`Fatal: ${err.message}`);
  process.exit(1);
});
