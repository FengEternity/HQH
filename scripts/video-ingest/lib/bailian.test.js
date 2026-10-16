'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildIntroRequest,
  hotwordEntries,
  resetHotwordCache,
  resolveBailianConfig,
  segmentsFromTranscript,
  transcribeSpeech,
  writeIntroText,
} = require('./bailian');

describe('bailian', () => {
  it('没有密钥时不调用接口', () => {
    assert.equal(resolveBailianConfig({}), null);
  });

  it('控制台上的 compatible-mode 地址会转成原生接口地址', () => {
    const config = resolveBailianConfig({
      DASHSCOPE_API_KEY: 'test-key',
      DASHSCOPE_BASE_URL: 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    });
    assert.equal(config.apiBase, 'https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1');
    assert.equal(
      config.chatUrl,
      'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
  });

  it('简介请求关掉思考并使用 qwen3.8-flash', () => {
    const body = buildIntroRequest('系统', '用户');
    assert.equal(body.model, 'qwen3.8-flash');
    assert.equal(body.enable_thinking, false);
    assert.equal(body.messages[0].content, '系统');
  });

  it('热词跳过过长的术语', () => {
    const entries = hotwordEntries(['司南', '这是一个超过十五个汉字的术语名称啊']);
    assert.deepEqual(entries.map((item) => item.text), ['司南']);
  });

  it('把百炼句子转成带时间的口播', () => {
    const segments = segmentsFromTranscript({
      transcripts: [{
        sentences: [{ text: '打开项目。', begin_time: 0, end_time: 1500 }],
      }],
    }, 3);
    assert.deepEqual(segments, [{ startSec: 0, endSec: 1.5, text: '打开项目。' }]);
  });

  it('转写上传后的音轨并写出简介', async () => {
    resetHotwordCache();
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).includes('list_vocabulary') || (options.body && String(options.body).includes('list_vocabulary'))) {
        return jsonResponse({ output: { vocabulary_list: [] } });
      }
      if (options.body && String(options.body).includes('create_vocabulary')) {
        return jsonResponse({ output: { vocabulary_id: 'vocab-1' } });
      }
      if (String(url).includes('getPolicy')) {
        return jsonResponse({
          data: {
            upload_host: 'https://upload.example/oss',
            upload_dir: 'dashscope/temp',
            oss_access_key_id: 'id',
            policy: 'policy',
            signature: 'sig',
          },
        });
      }
      if (String(url) === 'https://upload.example/oss') {
        return jsonResponse({}, 200);
      }
      if (String(url).includes('/transcription')) {
        return jsonResponse({ output: { task_id: 'task-1', task_status: 'PENDING' } });
      }
      if (String(url).includes('/tasks/task-1')) {
        return jsonResponse({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ transcription_url: 'https://result.example/transcript.json' }],
          },
        });
      }
      if (String(url) === 'https://result.example/transcript.json') {
        return jsonResponse({
          transcripts: [{ sentences: [{ text: '打开项目。', begin_time: 0, end_time: 1000 }] }],
        });
      }
      if (String(url).includes('chat/completions')) {
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'qwen3.8-flash');
        assert.equal(body.enable_thinking, false);
        return jsonResponse({ choices: [{ message: { content: '千寻本期讲解如何打开项目。' } }] });
      }
      throw new Error(`unexpected ${url}`);
    };
    const env = {
      DASHSCOPE_API_KEY: 'test-key',
      DASHSCOPE_BASE_URL: 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    };
    const segments = await transcribeSpeech({
      fetch: fetchImpl,
      env,
      audioBytes: Buffer.from('audio'),
      durationSec: 3,
      terms: ['司南'],
      sleep: async () => {},
    });
    assert.equal(segments[0].text, '打开项目。');
    const intro = await writeIntroText({
      fetch: fetchImpl,
      env,
      systemPrompt: '系统',
      userPrompt: '口播：打开项目。',
    });
    assert.equal(intro, '千寻本期讲解如何打开项目。');
    assert.equal(
      calls.find((call) => call.url.includes('getPolicy')).url,
      'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=fun-asr',
    );
    assert.equal(
      calls.some((call) => call.url.startsWith('https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription')),
      true,
    );
    assert.equal(
      calls.some((call) => call.url.includes('/compatible-mode/v1/uploads')),
      false,
    );
    assert.equal(
      calls.find((call) => call.url.includes('chat/completions')).url,
      'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
  });
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
