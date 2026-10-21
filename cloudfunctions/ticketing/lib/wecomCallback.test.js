'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');
const { handleWecomCallback, signature } = require('./wecomCallback');

const token = 'callback-token';
const corpId = 'ww-test';
const aesKey = crypto.randomBytes(32).toString('base64').replace(/=/g, '').slice(0, 43);

function pkcs7Pad(buffer) {
  const amount = 32 - (buffer.length % 32);
  return Buffer.concat([buffer, Buffer.alloc(amount, amount)]);
}

function encryptEcho(msg, receiveId) {
  const key = Buffer.from(aesKey + '=', 'base64');
  const msgBuf = Buffer.from(msg, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msgBuf.length, 0);
  const plain = pkcs7Pad(Buffer.concat([
    crypto.randomBytes(16),
    len,
    msgBuf,
    Buffer.from(receiveId, 'utf8'),
  ]));
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

function verifyEvent(echostr, receiveId = corpId) {
  const encrypted = encryptEcho(echostr, receiveId);
  return {
    httpMethod: 'GET',
    queryStringParameters: {
      echostr: encrypted,
      timestamp: '1700000000',
      nonce: 'nonce-1',
      msg_signature: signature(token, '1700000000', 'nonce-1', encrypted),
    },
  };
}

const env = {
  WECOM_CALLBACK_TOKEN: token,
  WECOM_CALLBACK_AES_KEY: aesKey,
  WECOM_CORP_ID: corpId,
};

test('校验通过时原样返回 echostr', () => {
  const result = handleWecomCallback(verifyEvent('ping-ok'), env);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'ping-ok');
});

test('签名不对时拒绝', () => {
  const event = verifyEvent('ping-ok');
  event.queryStringParameters.msg_signature = 'bad';
  const result = handleWecomCallback(event, env);
  assert.equal(result.statusCode, 403);
  assert.equal(result.body, '签名校验失败');
});

test('企业 ID 不一致时拒绝', () => {
  const result = handleWecomCallback(verifyEvent('ping-ok', 'other-corp'), env);
  assert.equal(result.statusCode, 403);
  assert.equal(result.body, '企业 ID 不匹配');
});

test('未配置时说明原因', () => {
  const result = handleWecomCallback(verifyEvent('ping-ok'), {});
  assert.equal(result.statusCode, 500);
  assert.equal(result.body, '回调未配置');
});

test('后续消息返回 success', () => {
  const result = handleWecomCallback({ httpMethod: 'POST', body: '<xml></xml>' }, env);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'success');
});
