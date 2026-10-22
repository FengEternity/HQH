'use strict';

const crypto = require('node:crypto');

const ASR_HOST = 'asr.tencentcloudapi.com';
const ASR_VERSION = '2019-06-14';

function envValue(env, name) {
  return String(env[name] || '').trim();
}

function chatCompletionsUrl(base) {
  const trimmed = String(base || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function resolveTencentConfig(env = process.env) {
  const secretId = envValue(env, 'TENCENTCLOUD_SECRET_ID') || envValue(env, 'TCB_SECRET_ID');
  const secretKey = envValue(env, 'TENCENTCLOUD_SECRET_KEY') || envValue(env, 'TCB_SECRET_KEY');
  if (!secretId || !secretKey) {
    return null;
  }
  return {
    secretId,
    secretKey,
    region: envValue(env, 'TENCENT_ASR_REGION'),
    asrEngine: envValue(env, 'TENCENT_ASR_ENGINE'),
    introKey: envValue(env, 'TOKENHUB_API_KEY'),
    introModel: envValue(env, 'TOKENHUB_MODEL'),
    chatUrl: chatCompletionsUrl(envValue(env, 'TOKENHUB_BASE_URL')),
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signTc3({
  secretId,
  secretKey,
  service,
  host,
  action,
  version,
  region,
  timestamp,
  payload,
}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(body),
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  const secretDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
  const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return {
    body,
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
      'X-TC-Region': region,
    },
  };
}

function segmentsFromAsrData(data, durationSec) {
  const details = Array.isArray(data && data.ResultDetail) ? data.ResultDetail : [];
  const segments = [];
  for (const detail of details) {
    const text = String(detail && (detail.FinalSentence || detail.SliceSentence) || '').trim();
    if (!text) {
      continue;
    }
    const begin = Number(detail.StartMs);
    const end = Number(detail.EndMs);
    segments.push({
      startSec: Number.isFinite(begin) ? begin / 1000 : 0,
      endSec: Number.isFinite(end) ? end / 1000 : durationSec,
      text,
    });
  }
  if (segments.length > 0) {
    return segments;
  }
  const lines = String(data && data.Result || '').split(/\r?\n/);
  for (const line of lines) {
    const matched = line.match(/^\[(\d+):(\d+(?:\.\d+)?),(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!matched) {
      continue;
    }
    const text = matched[5].trim();
    if (!text) {
      continue;
    }
    segments.push({
      startSec: Number(matched[1]) * 60 + Number(matched[2]),
      endSec: Number(matched[3]) * 60 + Number(matched[4]),
      text,
    });
  }
  return segments;
}

function introFromChatPayload(payload) {
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const content = message ? message.content : '';
  const text = Array.isArray(content)
    ? content.map((part) => (part && part.text) || '').join('')
    : String(content || '');
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function buildIntroRequest(systemPrompt, userPrompt, model) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 256,
    thinking: { type: 'disabled' },
    reasoning_effort: 'none',
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

async function callAsr(fetchImpl, config, action, payload, now) {
  const signed = signTc3({
    secretId: config.secretId,
    secretKey: config.secretKey,
    service: 'asr',
    host: ASR_HOST,
    action,
    version: ASR_VERSION,
    region: config.region,
    timestamp: Math.floor(now() / 1000),
    payload,
  });
  const response = await fetchImpl(`https://${ASR_HOST}`, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  const body = await readJson(response);
  const error = body.Response && body.Response.Error;
  if (!response.ok || error) {
    const code = error && error.Code ? error.Code : response.status;
    const message = error && error.Message ? error.Message : '请求失败';
    throw new Error(`腾讯云请求失败：${code} ${message}`);
  }
  return body.Response || {};
}

async function transcribeSpeech({
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  audioUrl,
  durationSec = 0,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const config = resolveTencentConfig(env);
  if (!config) {
    return null;
  }
  if (!config.asrEngine || !config.region) {
    throw new Error('缺少腾讯云语音识别配置');
  }
  if (!audioUrl) {
    throw new Error('腾讯云转写缺少音频地址');
  }
  const submitted = await callAsr(fetchImpl, config, 'CreateRecTask', {
    EngineModelType: config.asrEngine,
    ChannelNum: 1,
    ResTextFormat: 2,
    SourceType: 0,
    Url: audioUrl,
  }, now);
  const taskId = submitted.Data && submitted.Data.TaskId;
  if (taskId == null || taskId === '') {
    throw new Error('腾讯云转写没有任务号');
  }
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const queried = await callAsr(fetchImpl, config, 'DescribeTaskStatus', { TaskId: taskId }, now);
    const data = queried.Data || {};
    if (data.Status === 2) {
      const segments = segmentsFromAsrData(data, durationSec);
      if (segments.length === 0) {
        throw new Error('腾讯云转写没有句子');
      }
      return segments;
    }
    if (data.Status === 3) {
      throw new Error(`腾讯云转写失败：${data.ErrorMsg || 'failed'}`);
    }
    await sleep(2000);
  }
  throw new Error('腾讯云转写超时');
}

async function writeIntroText({
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  systemPrompt,
  userPrompt,
}) {
  const config = resolveTencentConfig(env);
  if (!config || !config.introKey || !config.introModel || !config.chatUrl) {
    return '';
  }
  const response = await fetchImpl(config.chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.introKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildIntroRequest(systemPrompt, userPrompt, config.introModel)),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = payload.error && payload.error.message
      ? payload.error.message
      : (payload.message || response.status);
    throw new Error(`腾讯云简介失败：${message}`);
  }
  const intro = introFromChatPayload(payload);
  if (!intro) {
    throw new Error('腾讯云简介为空');
  }
  return intro;
}

module.exports = {
  resolveTencentConfig,
  signTc3,
  segmentsFromAsrData,
  introFromChatPayload,
  buildIntroRequest,
  transcribeSpeech,
  writeIntroText,
};
