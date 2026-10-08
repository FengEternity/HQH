'use strict';

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  return err;
}

// durationSec 为 0 或缺失表示时长未知，此时不做上界校验；已知时长时字幕不得越界。
function resolveUpperBound(durationSec) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return Infinity;
  }
  return durationSec;
}

function normalizeVideoKnowledge(input) {
  const raw = input && input.transcriptSegments;
  if (!Array.isArray(raw)) {
    throw badInput('transcriptSegments must be an array');
  }

  const upperBound = resolveUpperBound(input && input.durationSec);
  const transcriptSegments = [];
  let prevStartSec = -Infinity;

  for (const segment of raw) {
    if (!segment || typeof segment !== 'object') {
      throw badInput('invalid transcript segment');
    }

    const startSec = segment.startSec;
    const endSec = segment.endSec;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec)) {
      throw badInput('startSec must be a finite number');
    }
    if (typeof endSec !== 'number' || !Number.isFinite(endSec)) {
      throw badInput('endSec must be a finite number');
    }
    if (startSec < 0) {
      throw badInput('startSec must be non-negative');
    }
    if (endSec <= startSec) {
      throw badInput('endSec must be greater than startSec');
    }
    if (startSec < prevStartSec) {
      throw badInput('transcriptSegments must be ordered by startSec');
    }
    if (endSec > upperBound) {
      throw badInput('endSec must not exceed durationSec');
    }

    const text = String(segment.text || '').trim();
    if (!text) {
      throw badInput('segment text must be non-empty');
    }

    transcriptSegments.push({ startSec, endSec, text });
    prevStartSec = startSec;
  }

  const transcript = transcriptSegments.map((segment) => segment.text).join('\n');

  if (
    input &&
    Object.prototype.hasOwnProperty.call(input, 'transcript') &&
    input.transcript !== undefined
  ) {
    const provided = String(input.transcript);
    if (provided !== transcript) {
      throw badInput('transcript conflicts with transcriptSegments');
    }
  }

  return { transcriptSegments, transcript };
}

// 只有请求显式提交分段时才按新规则严格校验并派生；旧管理端表单不带字幕字段，
// 必须原样保留库里已有的分段与全文，否则历史脏数据会让无关的保存全部失败。
function resolveVideoKnowledge({ event, prevData, durationSec }) {
  const source = event || {};
  if (!Object.prototype.hasOwnProperty.call(source, 'transcriptSegments')) {
    const previous = prevData || {};
    return {
      transcriptSegments: Array.isArray(previous.transcriptSegments)
        ? previous.transcriptSegments
        : [],
      transcript: typeof previous.transcript === 'string' ? previous.transcript : '',
    };
  }

  return normalizeVideoKnowledge({
    transcriptSegments: source.transcriptSegments,
    transcript: source.transcript,
    durationSec,
  });
}

module.exports = {
  badInput,
  normalizeVideoKnowledge,
  resolveVideoKnowledge,
};
