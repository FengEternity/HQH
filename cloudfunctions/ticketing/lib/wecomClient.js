'use strict';

const API_ROOT = 'https://qyapi.weixin.qq.com/cgi-bin';

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

function createWecomClient({ fetchImpl, env, now }) {
  let accessToken = '';

  async function fetchAccessToken() {
    const url = `${API_ROOT}/gettoken?corpid=${encodeURIComponent(env.WECOM_CORP_ID)}&corpsecret=${encodeURIComponent(env.WECOM_AGENT_SECRET)}`;
    const response = await fetchImpl(url, { method: 'GET' });
    accessToken = response.json.access_token;
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
    const json = await withAccessToken((token) => {
      const url = `${API_ROOT}/miniprogram/jscode2session?access_token=${encodeURIComponent(token)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
      return fetchImpl(url, { method: 'GET' });
    });
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

  async function sendGroup({ webhookUrl, userIds, now: at }) {
    const time = formatLocalTime(resolveNow(at, now));
    const body = {
      msgtype: 'text',
      文本: {
        content: `新工单\n待处理\n${time}`,
        mentioned_list: userIds,
      },
    };
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.json;
  }

  return { exchangeCode, sendPersonal, sendGroup };
}

module.exports = { createWecomClient };
