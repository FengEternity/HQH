'use strict';

const http = require('node:http');
const https = require('node:https');

const API_ROOT = 'https://qyapi.weixin.qq.com/cgi-bin';

function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https:') ? https : http;
    const req = lib.request(url, { method: options.method || 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch (error) {
          json = { errcode: 'BAD_JSON', errmsg: text.slice(0, 120) };
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json,
        });
      });
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error('请求企业微信超时'));
    });
    req.on('error', reject);
    if (options.body) {
      req.setHeader('Content-Type', 'application/json');
      req.write(options.body);
    }
    req.end();
  });
}

function formatLocalTime(ms) {
  const date = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}`;
}

function resolveNow(explicit, now) {
  if (explicit !== undefined && explicit !== null) {
    return explicit;
  }
  return typeof now === 'function' ? now() : now;
}

function tokenRejected(json) {
  const code = json && json.errcode;
  return code === 40014 || code === 42001;
}

function wecomFailure(stage, json) {
  const code = json && json.errcode != null ? json.errcode : '无返回';
  const errmsg = json && json.errmsg ? String(json.errmsg) : '';
  const error = new Error(stage + '：' + code + (errmsg ? ' ' + errmsg : ''));
  error.code = 'BIND_FAILED';
  return error;
}

function createWecomClient({ fetchImpl = nodeFetch, env, now } = {}) {
  let accessToken = '';

  async function fetchAccessToken() {
    const url = `${API_ROOT}/gettoken?corpid=${encodeURIComponent(env.WECOM_CORP_ID)}&corpsecret=${encodeURIComponent(env.WECOM_AGENT_SECRET)}`;
    const response = await fetchImpl(url, { method: 'GET' });
    const json = response.json || {};
    if (json.errcode || !json.access_token) {
      throw wecomFailure('获取企业微信凭证失败', json);
    }
    accessToken = json.access_token;
    return accessToken;
  }

  async function cachedAccessToken() {
    if (accessToken) {
      return accessToken;
    }
    return fetchAccessToken();
  }

  async function withAccessToken(send) {
    const first = await send(await cachedAccessToken());
    if (!tokenRejected(first.json)) {
      return first.json;
    }
    accessToken = '';
    const second = await send(await fetchAccessToken());
    return second.json;
  }

  async function exchangeCode(code) {
    let json;
    try {
      json = await withAccessToken((token) => {
        const url = `${API_ROOT}/miniprogram/jscode2session?access_token=${encodeURIComponent(token)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
        return fetchImpl(url, { method: 'GET' });
      });
    } catch (error) {
      if (error && error.code === 'BIND_FAILED') {
        throw error;
      }
      const wrapped = new Error('请求企业微信失败：' + ((error && error.message) || '未知错误'));
      wrapped.code = 'BIND_FAILED';
      throw wrapped;
    }
    if (!json || json.errcode) {
      throw wecomFailure('企业微信换码失败', json || {});
    }
    return { corpid: json.corpid, userid: json.userid };
  }

  async function sendPersonal({ userIds, appId, page, now: at }) {
    const time = formatLocalTime(resolveNow(at, now));
    const body = {
      touser: userIds.join('|'),
      msgtype: 'miniprogram_notice',
      agentid: Number.parseInt(env.WECOM_AGENT_ID, 10),
      miniprogram_notice: {
        appid: appId,
        page,
        title: '新工单',
        content_item: [
          { key: '状态', value: '待处理' },
          { key: '时间', value: time },
        ],
      },
    };
    return withAccessToken((token) => {
      const url = `${API_ROOT}/message/send?access_token=${encodeURIComponent(token)}`;
      return fetchImpl(url, { method: 'POST', body: JSON.stringify(body) });
    });
  }

  function previewText(raw) {
    const flat = String(raw || '').replace(/\s+/g, ' ').trim();
    if (flat.length <= 80) {
      return flat;
    }
    return `${flat.slice(0, 80)}…`;
  }

  function groupContent(time, notice, message) {
    if (notice === 'test') {
      return `通知测试\n${time}\n如果你看到这条 @，说明群提醒已接通。`;
    }
    if (!message) {
      return `新消息\n${time}`;
    }
    const nickname = String(message.nickname || '').trim() || '未留昵称';
    return `新消息\n${nickname}\n${previewText(message.text)}\n${time}`;
  }

  async function sendGroup({ webhookUrl, userIds, now: at, notice, message }) {
    const time = formatLocalTime(resolveNow(at, now));
    const mobiles = [];
    const accounts = [];
    (userIds || []).forEach((id) => {
      if (/^1\d{10}$/.test(id)) {
        mobiles.push(id);
      } else {
        accounts.push(id);
      }
    });
    const content = groupContent(time, notice, message);
    const text = { content };
    if (accounts.length) {
      text.mentioned_list = accounts;
    }
    if (mobiles.length) {
      text.mentioned_mobile_list = mobiles;
    }
    const body = { msgtype: 'text', text };
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.json;
  }

  return { exchangeCode, sendPersonal, sendGroup };
}

function createNotifyBinder({ env, client, now } = {}) {
  return {
    async sendTest(userId) {
      const webhookUrl = String((env && env.WECOM_GROUP_WEBHOOK) || '').trim();
      if (!webhookUrl) {
        const error = new Error('未配置运营群机器人');
        error.code = 'TEST_FAILED';
        throw error;
      }
      const json = await client.sendGroup({
        webhookUrl,
        userIds: [userId],
        now: typeof now === 'function' ? now() : now,
        notice: 'test',
      });
      if (!json || json.errcode) {
        const code = json && json.errcode != null ? json.errcode : '无返回';
        const error = new Error('已绑定，但测试消息没发到群：' + code);
        error.code = 'TEST_FAILED';
        throw error;
      }
    },
  };
}

module.exports = { createWecomClient, createNotifyBinder, nodeFetch };
