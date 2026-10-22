'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildIntroRequest,
  resolveTencentConfig,
  segmentsFromAsrData,
  signTc3,
  transcribeSpeech,
  writeIntroText,
} = require('./tencentSpeech');

describe('tencentSpeech', () => {
  it('没有云密钥时不调用接口', () => {
    assert.equal(resolveTencentConfig({}), null);
  });

  it('沿用云托管里已有的密钥，引擎和模型只读环境变量', () => {
    const config = resolveTencentConfig(speechEnv());
    assert.equal(config.secretId, 'id');
    assert.equal(config.asrEngine, '16k_zh');
    assert.equal(config.region, 'ap-shanghai');
    assert.equal(config.introModel, 'hy3');
    assert.equal(config.chatUrl, 'https://tokenhub.tencentmaas.com/v1/chat/completions');
  });

  it('未设置引擎、地域、模型和接口地址时不回落到写死值', () => {
    const config = resolveTencentConfig({
      TCB_SECRET_ID: 'id',
      TCB_SECRET_KEY: 'key',
    });
    assert.equal(config.asrEngine, '');
    assert.equal(config.region, '');
    assert.equal(config.introModel, '');
    assert.equal(config.chatUrl, '');
  });

  it('签名与腾讯云文档示例一致', () => {
    const exampleId = ['AKID', 'z8krbsJ5yKBZQpn74WFkmLPx3', 'EXAMPLE'].join('');
    const exampleKey = ['Gu5t9xGARNpq86cd98joQYCN3', 'EXAMPLE'].join('');
    const signed = signTc3({
      secretId: exampleId,
      secretKey: exampleKey,
      service: 'cvm',
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      version: '2017-03-12',
      region: 'ap-guangzhou',
      timestamp: 1551113065,
      payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
    });
    assert.equal(
      signed.headers.Authorization,
      `TC3-HMAC-SHA256 Credential=${exampleId}/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host, Signature=72e494ea809ad7a8c8f7a4507b9bddcbaa8e581f516e8da2f66e2c5a96525168`,
    );
  });

  it('简介请求使用调用方传入的模型并关闭深度思考', () => {
    const body = buildIntroRequest('系统', '用户', 'caller-model');
    assert.equal(body.model, 'caller-model');
    assert.equal(body.messages[0].content, '系统');
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning_effort, 'none');
  });

  it('把录音文件识别的句子转成口播', () => {
    const segments = segmentsFromAsrData({
      ResultDetail: [{ FinalSentence: '打开项目。', StartMs: 20, EndMs: 1500 }],
    }, 3);
    assert.deepEqual(segments, [{ startSec: 0.02, endSec: 1.5, text: '打开项目。' }]);
  });

  it('提交录音识别并写出简介', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), action: options.headers['X-TC-Action'], body: options.body });
      if (options.headers['X-TC-Action'] === 'CreateRecTask') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.EngineModelType, '16k_zh');
        assert.equal(payload.ChannelNum, 1);
        assert.equal(payload.Url, 'https://audio.example/speech.m4a');
        return jsonResponse({ Response: { Data: { TaskId: 42 } } });
      }
      if (options.headers['X-TC-Action'] === 'DescribeTaskStatus') {
        return jsonResponse({
          Response: {
            Data: {
              Status: 2,
              ResultDetail: [{ FinalSentence: '打开项目。', StartMs: 0, EndMs: 1000 }],
            },
          },
        });
      }
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'hy3');
      assert.deepEqual(body.thinking, { type: 'disabled' });
      return jsonResponse({ choices: [{ message: { content: '千寻本期讲解如何打开项目。' } }] });
    };
    const env = speechEnv();
    const segments = await transcribeSpeech({
      fetch: fetchImpl,
      env,
      audioUrl: 'https://audio.example/speech.m4a',
      durationSec: 3,
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
    assert.equal(calls[0].action, 'CreateRecTask');
    assert.equal(calls[1].action, 'DescribeTaskStatus');
  });

  it('缺少引擎或地域时拒绝转写', async () => {
    await assert.rejects(
      () => transcribeSpeech({
        env: speechEnv({ TENCENT_ASR_ENGINE: '', TENCENT_ASR_REGION: '' }),
        audioUrl: 'https://audio.example/speech.m4a',
        fetch: async () => {
          throw new Error('不应发起请求');
        },
      }),
      /缺少腾讯云语音识别配置/,
    );
  });
});

function speechEnv(overrides = {}) {
  return {
    TCB_SECRET_ID: 'id',
    TCB_SECRET_KEY: 'key',
    TOKENHUB_API_KEY: 'hub',
    TENCENT_ASR_ENGINE: '16k_zh',
    TENCENT_ASR_REGION: 'ap-shanghai',
    TOKENHUB_MODEL: 'hy3',
    TOKENHUB_BASE_URL: 'https://tokenhub.tencentmaas.com/v1',
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
