'use strict';

const INTRO_MODEL = 'qwen3.8-flash';
const ASR_MODEL = 'fun-asr';
const DEFAULT_API_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const UPLOAD_API_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const HOTWORD_PREFIX = 'hqh';

function resolveBailianConfig(env = process.env) {
  const apiKey = String(env.DASHSCOPE_API_KEY || '').trim();
  if (!apiKey) {
    return null;
  }
  const configured = String(env.DASHSCOPE_BASE_URL || DEFAULT_API_BASE).trim().replace(/\/$/, '');
  const nativeBase = configured.endsWith('/compatible-mode/v1')
    ? `${configured.slice(0, -'/compatible-mode/v1'.length)}/api/v1`
    : configured;
  const apiBase = nativeBase.endsWith('/api/v1') ? nativeBase : `${nativeBase}/api/v1`;
  const chatUrl = configured.endsWith('/compatible-mode/v1')
    ? `${configured}/chat/completions`
    : `${apiBase.slice(0, -'/api/v1'.length)}/compatible-mode/v1/chat/completions`;
  return { apiKey, apiBase, chatUrl, introModel: INTRO_MODEL, asrModel: ASR_MODEL };
}

function hotwordEntries(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const entries = [];
  for (const term of list) {
    const text = String(term || '').trim();
    if (!text || [...text].length > 15) {
      continue;
    }
    entries.push({
      text,
      weight: 4,
      lang: /[A-Za-z]/.test(text) && !/[\p{Script=Han}]/u.test(text) ? 'en' : 'zh',
    });
  }
  return entries;
}

function segmentsFromTranscript(payload, durationSec) {
  const transcripts = Array.isArray(payload && payload.transcripts) ? payload.transcripts : [];
  const segments = [];
  for (const transcript of transcripts) {
    const sentences = Array.isArray(transcript && transcript.sentences) ? transcript.sentences : [];
    for (const sentence of sentences) {
      const text = String(sentence && sentence.text || '').trim();
      if (!text) {
        continue;
      }
      const begin = Number(sentence.begin_time);
      const end = Number(sentence.end_time);
      segments.push({
        startSec: Number.isFinite(begin) ? begin / 1000 : 0,
        endSec: Number.isFinite(end) ? end / 1000 : durationSec,
        text,
      });
    }
    if (segments.length === 0) {
      const text = String(transcript && transcript.text || '').trim();
      if (text) {
        segments.push({ startSec: 0, endSec: durationSec, text });
      }
    }
  }
  return segments;
}

function introFromChatPayload(payload) {
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  return String(content || '').trim();
}

function buildIntroRequest(systemPrompt, userPrompt) {
  return {
    model: INTRO_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    enable_thinking: false,
    temperature: 0.2,
    max_tokens: 256,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

async function bailianJson(fetchImpl, config, url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...headers,
    },
    body,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = payload.message || payload.code || response.status;
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return '';
      }
    })();
    throw new Error(`百炼请求失败：${message}${path ? ` ${path}` : ''}`);
  }
  return payload;
}

async function ensureHotwordId(fetchImpl, config, terms) {
  const vocabulary = hotwordEntries(terms);
  if (vocabulary.length === 0) {
    return '';
  }
  const url = `${config.apiBase}/services/audio/asr/customization`;
  const listed = await bailianJson(fetchImpl, config, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'speech-biasing',
      input: {
        action: 'list_vocabulary',
        prefix: HOTWORD_PREFIX,
        page_index: 0,
        page_size: 10,
      },
    }),
  });
  const output = listed.output || {};
  const existing = (Array.isArray(output.vocabulary_list) ? output.vocabulary_list : [])
    .find((item) => item && item.target_model === ASR_MODEL);
  const action = existing ? 'update_vocabulary' : 'create_vocabulary';
  const input = {
    action,
    target_model: ASR_MODEL,
    vocabulary,
  };
  if (existing) {
    input.vocabulary_id = existing.vocabulary_id;
  } else {
    input.prefix = HOTWORD_PREFIX;
  }
  const saved = await bailianJson(fetchImpl, config, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'speech-biasing', input }),
  });
  return String((saved.output && saved.output.vocabulary_id) || (existing && existing.vocabulary_id) || '');
}

async function uploadSpeech(fetchImpl, config, audioBytes, filename) {
  const policyPayload = await bailianJson(
    fetchImpl,
    config,
    `${UPLOAD_API_BASE}/uploads?action=getPolicy&model=${encodeURIComponent(config.asrModel)}`,
  );
  const policy = policyPayload.data || policyPayload;
  const objectKey = `${String(policy.upload_dir || '').replace(/\/$/, '')}/${filename}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', policy.oss_access_key_id);
  form.append('policy', policy.policy);
  form.append('Signature', policy.signature);
  form.append('key', objectKey);
  form.append('x-oss-object-acl', policy.x_oss_object_acl || 'private');
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite || 'true');
  form.append('success_action_status', '200');
  form.append('file', new Blob([audioBytes]), filename);
  const uploaded = await fetchImpl(policy.upload_host, { method: 'POST', body: form });
  if (!uploaded.ok) {
    throw new Error('百炼音频上传失败');
  }
  return `oss://${objectKey}`;
}

async function transcribeUploaded(fetchImpl, config, fileUrl, vocabularyId, sleep) {
  const parameters = { language_hints: ['zh'] };
  if (vocabularyId) {
    parameters.vocabulary_id = vocabularyId;
  }
  const submitted = await bailianJson(
    fetchImpl,
    config,
    `${config.apiBase}/services/audio/asr/transcription`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'X-DashScope-OssResourceResolve': 'enable',
      },
      body: JSON.stringify({
        model: ASR_MODEL,
        input: { file_urls: [fileUrl] },
        parameters,
      }),
    },
  );
  const taskId = submitted.output && submitted.output.task_id;
  if (!taskId) {
    throw new Error('百炼转写没有任务号');
  }
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const task = await bailianJson(fetchImpl, config, `${config.apiBase}/tasks/${taskId}`);
    const status = task.output && task.output.task_status;
    if (status === 'SUCCEEDED') {
      const resultUrl = task.output.results && task.output.results[0] && task.output.results[0].transcription_url;
      if (!resultUrl) {
        throw new Error('百炼转写没有结果地址');
      }
      const resultResponse = await fetchImpl(resultUrl);
      if (!resultResponse.ok) {
        throw new Error('百炼转写结果下载失败');
      }
      return readJson(resultResponse);
    }
    if (status === 'FAILED') {
      throw new Error('百炼转写失败');
    }
    await sleep(2000);
  }
  throw new Error('百炼转写超时');
}

async function writeIntro(fetchImpl, config, systemPrompt, userPrompt) {
  const payload = await bailianJson(fetchImpl, config, config.chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildIntroRequest(systemPrompt, userPrompt)),
  });
  const intro = introFromChatPayload(payload);
  if (!intro) {
    throw new Error('百炼简介为空');
  }
  return intro;
}

let cachedHotwordId = '';

function resetHotwordCache() {
  cachedHotwordId = '';
}

async function transcribeSpeech({
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  audioBytes,
  filename = 'speech.m4a',
  durationSec = 0,
  terms,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const config = resolveBailianConfig(env);
  if (!config) {
    return null;
  }
  if (!cachedHotwordId) {
    try {
      cachedHotwordId = await ensureHotwordId(fetchImpl, config, terms);
    } catch {
      cachedHotwordId = '';
    }
  }
  const fileUrl = await uploadSpeech(fetchImpl, config, audioBytes, filename);
  const transcriptPayload = await transcribeUploaded(
    fetchImpl,
    config,
    fileUrl,
    cachedHotwordId,
    sleep,
  );
  const segments = segmentsFromTranscript(transcriptPayload, durationSec);
  if (segments.length === 0) {
    throw new Error('百炼转写没有句子');
  }
  return segments;
}

async function writeIntroText({
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  systemPrompt,
  userPrompt,
}) {
  const config = resolveBailianConfig(env);
  if (!config) {
    return '';
  }
  return writeIntro(fetchImpl, config, systemPrompt, userPrompt);
}

module.exports = {
  INTRO_MODEL,
  ASR_MODEL,
  resolveBailianConfig,
  hotwordEntries,
  segmentsFromTranscript,
  introFromChatPayload,
  buildIntroRequest,
  transcribeSpeech,
  writeIntroText,
  resetHotwordCache,
};
