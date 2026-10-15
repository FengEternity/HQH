'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  startSummaryDownload,
  summaryModelPresent,
  waitForSummaryModel,
} = require('./ensureSummaryModel');

describe('summary model download', () => {
  it('does not start when the weight is already present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-model-'));
    const modelPath = path.join(dir, 'model.gguf');
    fs.writeFileSync(modelPath, 'x');
    let called = false;
    const started = startSummaryDownload({
      env: {
        VIDEO_INGEST_SUMMARY_MODEL: modelPath,
        VIDEO_INGEST_PYTHON: '/opt/asr/bin/python',
      },
      spawnCommand() {
        called = true;
        return { unref() {} };
      },
    });
    assert.equal(started, false);
    assert.equal(called, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts a background download when the weight is missing', () => {
    const calls = [];
    const started = startSummaryDownload({
      env: {
        VIDEO_INGEST_SUMMARY_MODEL: path.join(os.tmpdir(), 'missing-summary-model.gguf'),
        VIDEO_INGEST_PYTHON: '/opt/asr/bin/python',
      },
      spawnCommand(command, args) {
        calls.push({ command, args });
        return { unref() {} };
      },
    });
    assert.equal(started, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/opt/asr/bin/python');
    assert.equal(path.basename(calls[0].args[0]), 'fetch_summary_model.py');
  });

  it('waits until the weight file appears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-wait-'));
    const modelPath = path.join(dir, 'model.gguf');
    let clock = 0;
    const ready = await waitForSummaryModel(modelPath, {
      timeoutMs: 50,
      intervalMs: 10,
      now: () => clock,
      sleep() {
        clock += 10;
        if (clock === 20) {
          fs.writeFileSync(modelPath, 'ready');
        }
        return Promise.resolve();
      },
    });
    assert.equal(ready, true);
    assert.equal(summaryModelPresent(modelPath), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
