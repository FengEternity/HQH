'use strict';

const http = require('node:http');
const os = require('node:os');

const cloudbase = require('@cloudbase/node-sdk');

const { runOnce } = require('./lib/workerLoop');
const { createRunQueue, keepClaiming } = require('./lib/runQueue');
const {
  callCatalog,
  createCatalog,
  createJobDependencies,
  hasAllCredentials,
  readCredentials,
  runInTemporaryWorkspace,
} = require('./worker');
const { startSummaryDownload } = require('./ensureSummaryModel');

function createServer({
  env = process.env,
  createApp = (config) => cloudbase.init(config),
} = {}) {
  const credentials = readCredentials(env);
  let queue = null;

  async function ensureQueue() {
    if (!hasAllCredentials(credentials)) {
      const error = new Error('NO_CREDENTIALS');
      error.code = 'NO_CREDENTIALS';
      throw error;
    }
    if (queue) {
      return queue;
    }
    const app = createApp({
      env: credentials.envId,
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
    });
    const login = await callCatalog(app, {
      action: 'adminLogin',
      pin: credentials.adminPin,
    });
    const catalog = createCatalog(
      app,
      String(login.ticket || ''),
      credentials.adminPin,
    );
    const workerId = `${os.hostname()}-${process.pid}`;
    queue = createRunQueue({
      runOnce: () =>
        runInTemporaryWorkspace((workspace) =>
          runOnce(
            createJobDependencies({
              app,
              catalog,
              workerId,
              workspace,
              env,
            }),
          ),
        ),
    });
    return queue;
  }

  const server = http.createServer(async (request, response) => {
    const path = String(request.url || '').split('?')[0];
    if (request.method !== 'POST' || path !== '/run') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
      return;
    }
    try {
      const active = await ensureQueue();
      active.poke();
      let started = true;
      if (!active.isResident()) {
        const result = active.start();
        result.done.catch(() => {});
        started = result.started;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, started }));
    } catch (error) {
      const code = error && error.code === 'NO_CREDENTIALS' ? 'NO_CREDENTIALS' : 'FAIL';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, code }));
    }
  });

  return { server, ensureQueue };
}

if (require.main === module) {
  startSummaryDownload();
  const port = Number(process.env.PORT) || 80;
  const { server, ensureQueue } = createServer();
  server.listen(port, () => {
    if (process.env.VIDEO_INGEST_RESIDENT === '1') {
      ensureQueue()
        .then((active) => keepClaiming(active, (ms) => new Promise((resolve) => setTimeout(resolve, ms)), 15000))
        .catch(() => {});
    }
  });
}

module.exports = { createServer };
