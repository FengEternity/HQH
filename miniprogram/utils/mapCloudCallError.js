'use strict';

function mapCloudCallError(err, functionName) {
  const code = err && (err.errCode || err.code);
  const msg = String((err && (err.errMsg || err.message)) || '');
  if (
    code === -501000 ||
    /FUNCTION_NOT_FOUND/i.test(msg) ||
    /FunctionName parameter could not be found/i.test(msg)
  ) {
    const mapped = new Error(`${functionName} 云函数未部署`);
    mapped.code = 'FUNCTION_NOT_FOUND';
    return mapped;
  }
  if (
    code === -504002 ||
    /Cannot find module ['"]wx-server-sdk['"]/i.test(msg) ||
    /functions execute fail/i.test(msg) && /wx-server-sdk/i.test(msg)
  ) {
    const mapped = new Error(
      `${functionName} 云函数依赖未安装，请云端安装依赖后重部署`,
    );
    mapped.code = 'FUNCTION_DEPS_MISSING';
    return mapped;
  }
  if (err instanceof Error) {
    // WeChat often puts the useful code on errCode while message is a wall of text
    if (msg.length > 40 && /cloud\.callFunction/i.test(msg)) {
      const mapped = new Error(`${functionName} 调用失败`);
      mapped.code = code || err.code || 'FAIL';
      return mapped;
    }
    return err;
  }
  const mapped = new Error(msg || '请求失败');
  mapped.code = code || 'FAIL';
  return mapped;
}

module.exports = { mapCloudCallError };
