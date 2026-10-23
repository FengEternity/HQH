'use strict';

const { runVideoDocTurn } = require('./videoDocTurn');
const { agentRunId } = require('./runTurn');
const store = require('./videoDocStore');

const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 1000;

function fail(code, message) {
  return { ok: false, code, message };
}

function clean(value) {
  return String(value || '').trim();
}

function requestIdOk(value) {
  return value.length > 0 && value.length <= 64 && !/\s/.test(value);
}

function timeOk(currentTimeSec) {
  if (currentTimeSec === undefined || currentTimeSec === null || currentTimeSec === '') return true;
  const sec = Number(currentTimeSec);
  return Number.isInteger(sec) && sec >= 0;
}

async function threadMessages(db, threadId) {
  const rows = await store.listMessages(db, threadId);
  return rows.map(store.publicMessage);
}

async function exportBestEffort(input, turn) {
  if (typeof input.exportTrace !== 'function') return;
  try {
    await input.exportTrace(turn);
  } catch (error) {
    return;
  }
}

async function videoDocHistory(db, input) {
  const openid = clean(input && input.openid);
  const videoId = clean(input && input.videoId);
  if (!openid) return fail('FORBIDDEN', '请先登录');
  if (!videoId) return fail('BAD_INPUT', '请从讲解页提问');
  const thread = await store.findThread(db, openid, videoId);
  if (!thread) return { ok: true, messages: [] };
  return { ok: true, messages: await threadMessages(db, thread._id) };
}

async function videoDocSend(db, input) {
  const openid = clean(input && input.openid);
  const videoId = clean(input && input.videoId);
  const text = clean(input && input.text);
  const requestId = clean(input && input.requestId);
  const now = Number(input && input.now) || Date.now();
  if (!openid) return fail('FORBIDDEN', '请先登录');
  if (!videoId) return fail('BAD_INPUT', '请从讲解页提问');
  if (!text) return fail('BAD_INPUT', '请输入问题');
  if (text.length > 500) return fail('BAD_INPUT', '问题请控制在 500 字以内');
  if (!requestIdOk(requestId)) return fail('BAD_INPUT', '请求编号不正确');
  if (!timeOk(input && input.currentTimeSec)) return fail('BAD_INPUT', '播放位置不正确');

  let video;
  try {
    video = await input.loadVideo(videoId);
  } catch (error) {
    return fail('DOMAIN_UNAVAILABLE', '讲解暂时无法读取，请稍后再试');
  }
  if (!video || video.status !== 'published') {
    return fail('NOT_FOUND', '这条讲解暂时不能提问');
  }

  if (typeof input.checkContent === 'function') {
    try {
      await input.checkContent(text);
    } catch (error) {
      return fail('CONTENT_REJECTED', '文案未通过内容安全检测，请修改后重发');
    }
  }

  const hash = store.scopeHash(openid, videoId);
  const existing = await store.findRun(db, hash, requestId);
  const thread = await store.findThread(db, openid, videoId);
  if (existing && existing.status === 'succeeded' && thread) {
    const messages = await threadMessages(db, thread._id);
    const assistant = messages.filter((item) => item.meta && item.meta.agentRunId === existing.agentRunId).pop();
    return {
      ok: true,
      status: 'replayed',
      text: assistant ? assistant.text : '',
      cards: (assistant && assistant.meta && assistant.meta.cards) || [],
      messages,
      agentRunId: existing.agentRunId,
      messageId: assistant ? assistant.id : '',
    };
  }
  if (existing && existing.status === 'running') {
    return fail('IN_PROGRESS', '正在回答，请稍候');
  }
  const runs = await store.listRuns(db, hash);
  if (runs.some((item) => item.status === 'running')) {
    return fail('IN_PROGRESS', '正在回答，请稍候');
  }
  if (existing && existing.status === 'failed' && Number(existing.resumeCount) >= 1) {
    return {
      ok: false,
      code: existing.code || 'MODEL_UNAVAILABLE',
      message: '暂时无法回答，请稍后再试',
      messages: thread ? await threadMessages(db, thread._id) : [],
      agentRunId: existing.agentRunId,
    };
  }

  const resuming = Boolean(existing && existing.status === 'failed');
  let savedThread = thread;
  let run = existing;
  let runId = existing ? existing.agentRunId : agentRunId(requestId);
  let userMessageId = '';
  if (!resuming) {
    const recent = runs.filter((item) => Number(item.createdAt) >= now - RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      return fail('RATE_LIMITED', '提问太频繁，请稍后再试');
    }
    savedThread = thread || (await store.ensureThread(db, { openid, videoId, now }));
    const userMessage = await store.appendMessage(db, {
      threadId: savedThread._id,
      openid,
      videoId,
      role: 'user',
      text,
      meta: { requestId },
      createdAt: now,
    });
    userMessageId = userMessage._id;
    runId = agentRunId(requestId);
    run = await store.addRun(db, {
      requestId,
      agentRunId: runId,
      profileId: 'video_doc',
      profileVersion: 'v1',
      scopeHash: hash,
      actorType: 'end_user',
      status: 'running',
      code: '',
      resumeCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await store.updateRun(db, existing._id, { status: 'running', updatedAt: now });
  }
  const failedPatch = (code) => ({
    status: 'failed',
    code,
    resumeCount: resuming ? 1 : 0,
    updatedAt: now,
  });

  if (typeof input.executor !== 'function') {
    await store.updateRun(db, run._id, failedPatch('MODEL_UNAVAILABLE'));
    await exportBestEffort(input, {
      requestId,
      agentRunId: runId,
      profileId: 'video_doc',
      profileVersion: 'v1',
      scopeHash: hash,
      spans: [{ name: 'gate', status: 'error', durationMs: 0, enteredModel: false, resultCode: 'MODEL_UNAVAILABLE' }],
    });
    return {
      ok: false,
      code: 'MODEL_UNAVAILABLE',
      message: '暂时无法回答，请稍后再试',
      messages: await threadMessages(db, savedThread._id),
      agentRunId: runId,
    };
  }

  let result;
  try {
    result = await runVideoDocTurn({
      videoId,
      text,
      requestId,
      currentTimeSec: input.currentTimeSec,
      actor: { type: 'end_user' },
      loadVideo: async () => video,
      loadLinkedProducts: input.loadLinkedProducts,
      executor: input.executor,
    });
  } catch (error) {
    const code = error && (error.code === 'MODEL_UNAVAILABLE' || error.code === 'TIMEOUT')
      ? error.code
      : 'DOMAIN_UNAVAILABLE';
    const message = code === 'TIMEOUT'
      ? '回答超时，请再试一次'
      : code === 'MODEL_UNAVAILABLE'
        ? '暂时无法回答，请稍后再试'
        : '讲解暂时无法读取，请稍后再试';
    await store.updateRun(db, run._id, failedPatch(code));
    await exportBestEffort(input, {
      requestId,
      agentRunId: runId,
      profileId: 'video_doc',
      profileVersion: 'v1',
      scopeHash: hash,
      spans: [
        {
          name: 'model',
          status: 'error',
          durationMs: 0,
          enteredModel: code !== 'DOMAIN_UNAVAILABLE',
          resultCode: code,
        },
      ],
    });
    return {
      ok: false,
      code,
      message,
      messages: await threadMessages(db, savedThread._id),
      agentRunId: runId,
    };
  }

  if (!result.ok) {
    await store.updateRun(db, run._id, failedPatch(result.code || 'failed'));
    await exportBestEffort(input, {
      requestId,
      agentRunId: runId,
      profileId: 'video_doc',
      profileVersion: 'v1',
      scopeHash: hash,
      spans: result.spans || [],
    });
    return {
      ok: false,
      code: result.code,
      message: result.message,
      messages: await threadMessages(db, savedThread._id),
      agentRunId: runId,
    };
  }

  const assistant = await store.appendMessage(db, {
    threadId: savedThread._id,
    openid,
    videoId,
    role: 'assistant',
    text: result.text,
    meta: {
      source: 'agent',
      profileVersion: result.profileVersion,
      agentRunId: result.agentRunId,
      cards: result.cards || [],
    },
    createdAt: now + 1,
  });
  await store.updateRun(db, run._id, { status: 'succeeded', code: '', updatedAt: now + 1 });
  await exportBestEffort(input, {
    requestId,
    agentRunId: result.agentRunId,
    profileId: 'video_doc',
    profileVersion: result.profileVersion,
    scopeHash: hash,
    spans: result.spans || [],
  });
  return {
    ok: true,
    status: 'succeeded',
    text: result.text,
    cards: result.cards || [],
    messages: await threadMessages(db, savedThread._id),
    agentRunId: result.agentRunId,
    messageId: assistant._id,
    userMessageId,
  };
}

module.exports = { videoDocSend, videoDocHistory, RATE_LIMIT };
