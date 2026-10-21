'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('about page', () => {
  it('keeps the changelog on the staff path and marks each note', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'about.wxml'), 'utf8');
    const staffAt = wxml.indexOf('wx:if="{{staff}}"');
    const titleAt = wxml.indexOf('更新说明');
    assert.ok(staffAt >= 0);
    assert.ok(titleAt > staffAt);
    const section = wxml.slice(titleAt);
    assert.equal(section.includes('class="note-mark"'), true);
    assert.equal((section.match(/·/g) || []).length, 2);
  });
});
