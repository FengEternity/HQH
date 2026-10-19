'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUMMARY_WAIT_MS = 20 * 60 * 1000;

function summaryModelPresent(modelPath) {
  try {
    return fs.statSync(modelPath).isFile() && fs.statSync(modelPath).size > 0;
  } catch {
    return false;
  }
}

function startSummaryDownload({
  env = process.env,
  spawnCommand = spawn,
} = {}) {
  const modelPath = String(env.VIDEO_INGEST_SUMMARY_MODEL || '').trim();
  const python = String(env.VIDEO_INGEST_PYTHON || '').trim();
  if (!modelPath || !python || summaryModelPresent(modelPath)) {
    return false;
  }
  const child = spawnCommand(python, [path.join(__dirname, 'fetch_summary_model.py')], {
    stdio: 'inherit',
    env,
  });
  if (child && typeof child.on === 'function') {
    child.on('exit', (code) => {
      process.stderr.write(`summary model download exit ${code}\n`);
    });
  }
  if (child && typeof child.unref === 'function') {
    child.unref();
  }
  return true;
}

async function waitForSummaryModel(modelPath, {
  timeoutMs = SUMMARY_WAIT_MS,
  intervalMs = 2000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  while (!summaryModelPresent(modelPath)) {
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
  return true;
}

module.exports = {
  startSummaryDownload,
  summaryModelPresent,
  waitForSummaryModel,
};
