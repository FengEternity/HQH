'use strict';

const crypto = require('node:crypto');

function signature(token, timestamp, nonce, encrypt) {
  const raw = [token, timestamp, nonce, encrypt].map((item) => String(item || '')).sort().join('');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function pkcs7Unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  if (pad < 1 || pad > 32) {
    throw new Error('bad pad');
  }
  return buffer.subarray(0, buffer.length - pad);
}

function decryptEcho(encodingAESKey, encrypted) {
  const aesKey = Buffer.from(String(encodingAESKey) + '=', 'base64');
  if (aesKey.length !== 32) {
    throw new Error('bad aes key');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = pkcs7Unpad(Buffer.concat([
    decipher.update(String(encrypted).replace(/ /g, '+'), 'base64'),
    decipher.final(),
  ]));
  const msgLen = decrypted.readUInt32BE(16);
  return {
    msg: decrypted.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: decrypted.subarray(20 + msgLen).toString('utf8'),
  };
}

function readQuery(event) {
  const params = event && event.queryStringParameters;
  if (params && typeof params === 'object') {
    return params;
  }
  if (event && typeof event.queryString === 'string') {
    return Object.fromEntries(new URLSearchParams(event.queryString));
  }
  return {};
}

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: String(body),
  };
}

function handleWecomCallback(event, env) {
  const method = String((event && event.httpMethod) || 'GET').toUpperCase();
  if (method !== 'GET') {
    return httpResponse(200, 'success');
  }
  const query = readQuery(event);
  const echostr = String(query.echostr || '').replace(/ /g, '+');
  if (!echostr) {
    return httpResponse(400, '缺少 echostr');
  }
  const token = env && env.WECOM_CALLBACK_TOKEN;
  const aesKey = env && env.WECOM_CALLBACK_AES_KEY;
  const corpId = env && env.WECOM_CORP_ID;
  if (!token || !aesKey || !corpId) {
    return httpResponse(500, '回调未配置');
  }
  if (signature(token, query.timestamp, query.nonce, echostr) !== query.msg_signature) {
    return httpResponse(403, '签名校验失败');
  }
  let plain;
  try {
    plain = decryptEcho(aesKey, echostr);
  } catch (error) {
    return httpResponse(403, '解密失败');
  }
  if (plain.receiveId !== corpId) {
    return httpResponse(403, '企业 ID 不匹配');
  }
  return httpResponse(200, plain.msg);
}

module.exports = { handleWecomCallback, signature, decryptEcho };
