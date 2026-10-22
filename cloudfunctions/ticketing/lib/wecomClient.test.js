'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const test = require('node:test');
const { createWecomClient, createNotifyBinder, nodeFetch } = require('./wecomClient');

const env = {
  WECOM_CORP_ID: 'corp-1',
  WECOM_AGENT_ID: '1001',
  WECOM_AGENT_SECRET: 'secret-1',
};

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options = {}) {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const route = routes.find((item) => url.includes(item.match));
      return { ok: true, status: 200, json: route ? route.json : { errcode: 0 } };
    },
  };
}

test('默认请求使用 Node 网络库', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ errcode: 0, access_token: 'token-1' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await nodeFetch('http://127.0.0.1:' + port + '/gettoken');
    assert.equal(result.ok, true);
    assert.equal(result.json.access_token, 'token-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('code 换成 userid', async () => {
  const http = fakeFetch([
    { match: 'gettoken', json: { errcode: 0, access_token: 'token-1', expires_in: 7200 } },
    { match: 'jscode2session', json: { errcode: 0, corpid: 'corp-1', userid: 'zhangsan', session_key: 'hidden' } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1 });
  const result = await client.exchangeCode('login-code');
  assert.deepEqual(result, { corpid: 'corp-1', userid: 'zhangsan' });
  assert.equal(JSON.stringify(http.calls).includes('hidden'), false);
});

test('个人消息走应用，群消息走机器人', async () => {
  const http = fakeFetch([
    { match: 'gettoken', json: { errcode: 0, access_token: 'token-1', expires_in: 7200 } },
    { match: 'message/send', json: { errcode: 0, invaliduser: '' } },
    { match: 'webhook', json: { errcode: 0 } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1_700_000_000_000 });
  await client.sendPersonal({
    userIds: ['zhangsan', 'lisi'],
    appId: 'wx-app',
    page: 'pages/admin/ticket/ticket?id=thread-1',
    now: 1_700_000_000_000,
  });
  await client.sendGroup({
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo',
    userIds: ['zhangsan', 'lisi'],
    now: 1_700_000_000_000,
  });
  const personal = http.calls.find((call) => call.url.includes('message/send'));
  const group = http.calls.find((call) => call.url.includes('webhook'));
  assert.equal(personal.body.touser, 'zhangsan|lisi');
  assert.equal(personal.body.msgtype, 'miniprogram_notice');
  assert.equal(personal.body.miniprogram_notice.page, 'pages/admin/ticket/ticket?id=thread-1');
  assert.deepEqual(group.body.text.mentioned_list, ['zhangsan', 'lisi']);
  const mobile = await client.sendGroup({
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo',
    userIds: ['13800000000'],
    now: 1_700_000_000_000,
  });
  assert.equal(mobile.errcode, 0);
  const mobileCall = http.calls.filter((call) => call.url.includes('webhook')).pop();
  assert.deepEqual(mobileCall.body.text.mentioned_mobile_list, ['13800000000']);
  assert.equal(mobileCall.body.text.mentioned_list, undefined);
  assert.equal(group.body.text.content.includes('新消息'), true);
});

test('正式通知带昵称、原话和时间，过长截断且换行压成空格', async () => {
  const http = fakeFetch([
    { match: 'webhook', json: { errcode: 0 } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1_700_000_000_000 });
  const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo';
  await client.sendGroup({
    webhookUrl,
    userIds: ['13800000000'],
    now: 1_700_000_000_000,
    message: { nickname: '张三', text: '我想查一下\n订单发到哪了' },
  });
  await client.sendGroup({
    webhookUrl,
    userIds: ['13800000000'],
    now: 1_700_000_000_000,
    message: { nickname: '  ', text: `${'啊'.repeat(81)}尾` },
  });
  await client.sendGroup({
    webhookUrl,
    userIds: ['13800000000'],
    now: 1_700_000_000_000,
    notice: 'test',
    message: { nickname: '张三', text: '这句不该出现在测试里' },
  });
  const calls = http.calls.filter((item) => item.url.includes('webhook'));
  assert.equal(
    calls[0].body.text.content,
    '新消息\n张三\n我想查一下 订单发到哪了\n2023年11月15日 06:13',
  );
  assert.equal(
    calls[1].body.text.content,
    `新消息\n未留昵称\n${'啊'.repeat(80)}…\n2023年11月15日 06:13`,
  );
  assert.equal(calls[1].body.text.content.includes('尾'), false);
  assert.equal(calls[2].body.text.content.includes('通知测试'), true);
  assert.equal(calls[2].body.text.content.includes('这句不该出现在测试里'), false);
});

test('测试提醒标明是测试并按手机号 @', async () => {
  const http = fakeFetch([
    { match: 'webhook', json: { errcode: 0 } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1_700_000_000_000 });
  await client.sendGroup({
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo',
    userIds: ['13800000000'],
    now: 1_700_000_000_000,
    notice: 'test',
  });
  const call = http.calls.find((item) => item.url.includes('webhook'));
  assert.equal(call.body.text.content.includes('通知测试'), true);
  assert.equal(call.body.text.content.includes('新消息'), false);
  assert.deepEqual(call.body.text.mentioned_mobile_list, ['13800000000']);
  assert.equal(call.body.text.mentioned_list, undefined);
});

test('未配置群机器人时测试提醒直接失败', async () => {
  const binder = createNotifyBinder({
    env: { WECOM_GROUP_WEBHOOK: '  ' },
    client: { sendGroup: async () => { throw new Error('should not send'); } },
    now: 10,
  });
  await assert.rejects(
    () => binder.sendTest('zhangsan'),
    (error) => error.message === '未配置运营群机器人',
  );
});

test('群机器人拒绝测试提醒时带上错误码', async () => {
  let payload;
  const binder = createNotifyBinder({
    env: { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook' },
    client: {
      sendGroup: async (input) => {
        payload = input;
        return { errcode: 93000, errmsg: 'invalid' };
      },
    },
    now: 10,
  });
  await assert.rejects(
    () => binder.sendTest('zhangsan'),
    (error) => error.message === '已绑定，但测试消息没发到群：93000',
  );
  assert.equal(payload.notice, 'test');
  assert.deepEqual(payload.userIds, ['zhangsan']);
});

test('凭证失败时说明错误码且不带 Secret', async () => {
  const http = fakeFetch([
    { match: 'gettoken', json: { errcode: 40013, errmsg: 'invalid corpid' } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1 });
  await assert.rejects(
    () => client.exchangeCode('login-code'),
    (error) =>
      error.code === 'BIND_FAILED' &&
      error.message.includes('40013') &&
      error.message.includes('获取企业微信凭证失败') &&
      !error.message.includes('secret-1'),
  );
});

test('access_token 过期时刷新一次', async () => {
  let tokenCalls = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url.includes('gettoken')) {
      tokenCalls += 1;
      return { ok: true, status: 200, json: { errcode: 0, access_token: 'token-' + tokenCalls, expires_in: 7200 } };
    }
    const body = JSON.parse(options.body);
    if (url.includes('message/send') && calls.filter((item) => item.includes('message/send')).length === 1) {
      return { ok: true, status: 200, json: { errcode: 42001, errmsg: 'expired' } };
    }
    assert.equal(body.agentid, 1001);
    return { ok: true, status: 200, json: { errcode: 0 } };
  };
  const client = createWecomClient({ fetchImpl, env, now: () => 1 });
  const result = await client.sendPersonal({
    userIds: ['zhangsan'],
    appId: 'wx-app',
    page: 'pages/admin/ticket/ticket?id=thread-1',
    now: 1,
  });
  assert.equal(result.errcode, 0);
  assert.equal(tokenCalls, 2);
});
