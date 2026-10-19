'use strict';

const { pinyin } = require('pinyin-pro');

function readingsOf(char) {
  const result = pinyin(char, { toneType: 'none', type: 'array', multiple: true });
  const readings = (Array.isArray(result) ? result : [])
    .map((item) => String(item || '').replace(/ü/g, 'v'))
    .filter((item) => /^[a-z]+$/.test(item));
  if (readings.length === 0) {
    return [`u${char.codePointAt(0)}`];
  }
  return readings;
}

function hanSyllables(text) {
  const syllables = [];
  for (const char of String(text || '')) {
    if (!/\p{Script=Han}/u.test(char)) {
      continue;
    }
    syllables.push(readingsOf(char));
  }
  return syllables;
}

function syllableSetsMatch(left, right) {
  return left.some((reading) => right.includes(reading));
}

module.exports = {
  hanSyllables,
  syllableSetsMatch,
};
