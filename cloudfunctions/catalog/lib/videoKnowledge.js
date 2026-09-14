'use strict';

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  return err;
}

function normalizeVideoKnowledge(input) {
  const raw = input && input.transcriptSegments;
  if (!Array.isArray(raw)) {
    throw badInput('transcriptSegments must be an array');
  }

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

module.exports = {
  badInput,
  normalizeVideoKnowledge,
};
