'use strict';

const { createTokenHubClient, verifyServiceProof } = require('./ai-runtime');
const { loadPlaceModelName } = require('./agentModelAction');
const { visibleText } = require('./videoDocModel');

const PURPOSE = 'video-ingest:write-intro';
const INTRO_TRANSCRIPT_LIMIT = 4000;
const INTRO_SYSTEM_PROMPT = [
  '你是测绘仪器讲解视频的编辑。',
  '根据用户给出的标题、品牌、术语表和口播，只写一段简介正文。',
  '先点明品牌和这期功能，再按口播里的真实顺序写下主要操作。',
  '去掉大家好、点赞、转发、下期再见，以及过细的单次点击。',
  '术语表只用来把口播里听错的词改成正确写法。',
  '术语表里有、但这期标题和口播都没提到的词不要写。',
  '不要补充这期没提到的文件格式、有线、无线、蓝牙或一键。',
  '整段尽量不超过 100 字，不少于 10 字，1 到 4 句。',
  '不要输出标题、解释或引号。',
].join('');

function clipIntroTranscript(transcript) {
  const text = String(transcript || '');
  if ([...text].length <= INTRO_TRANSCRIPT_LIMIT) return text;
  return [...text].slice(0, INTRO_TRANSCRIPT_LIMIT).join('');
}

function buildIntroUserPrompt({ title, brandName, transcript, terms }) {
  const termList = Array.isArray(terms) ? terms.filter((term) => typeof term === 'string') : [];
  const spoken = clipIntroTranscript(transcript);
  const clipped = [...String(transcript || '')].length > INTRO_TRANSCRIPT_LIMIT;
  return [
    `标题：${title || ''}`,
    `品牌：${brandName || ''}`,
    `术语表：${termList.join('、')}`,
    `口播：${spoken}`,
    clipped ? `口播已截取前 ${INTRO_TRANSCRIPT_LIMIT} 字` : '',
  ].filter(Boolean).join('\n');
}

function badInput() {
  const error = new Error('BAD_INPUT');
  error.code = 'BAD_INPUT';
  return error;
}

function boundedText(value, max) {
  if (typeof value !== 'string') throw badInput();
  const text = value.trim();
  if ([...text].length > max) throw badInput();
  return text;
}

function boundedTerms(value) {
  if (!Array.isArray(value) || value.length > 500) throw badInput();
  return value.map((term) => boundedText(term, 80));
}

async function writeVideoIntro({ db, env = {}, event = {}, fetch, openid, now = Date.now }) {
  const clock = typeof now === 'function' ? now() : now;
  if (openid || !verifyServiceProof(env.ADMIN_PIN, PURPOSE, event.proof, clock)) {
    return { ok: false, code: 'UNAUTHORIZED', message: '未授权' };
  }
  let title;
  let brandName;
  let transcript;
  let terms;
  try {
    title = boundedText(event.title, 200);
    brandName = boundedText(event.brandName, 80);
    transcript = boundedText(event.transcript, 100000);
    terms = boundedTerms(event.terms);
    if (!transcript) throw badInput();
  } catch (error) {
    if (error && error.code === 'BAD_INPUT') {
      return { ok: false, code: 'BAD_INPUT', message: '简介材料无效' };
    }
    throw error;
  }
  const model = await loadPlaceModelName(db, 'video_intro', env);
  try {
    const result = await createTokenHubClient({ env, fetch }).chat({
      model,
      messages: [
        { role: 'system', content: INTRO_SYSTEM_PROMPT },
        { role: 'user', content: buildIntroUserPrompt({ title, brandName, transcript, terms }) },
      ],
      temperature: 0.2,
      max_tokens: 256,
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      timeoutMs: 20000,
    });
    const text = visibleText(result.message && result.message.content).text;
    if (!text) {
      return { ok: false, code: 'MODEL_UNAVAILABLE', message: '模型没有返回可用文字' };
    }
    return { ok: true, intro: text, model: result.model || model };
  } catch (error) {
    console.error('video intro write failed', error && error.code || '');
    return { ok: false, code: 'MODEL_UNAVAILABLE', message: '暂时无法调用，请稍后再试' };
  }
}

module.exports = { PURPOSE, INTRO_SYSTEM_PROMPT, INTRO_TRANSCRIPT_LIMIT, buildIntroUserPrompt, writeVideoIntro };
