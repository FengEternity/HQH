'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideThreeLaneNotice, mergeThreeLanes } = require('./mergeNotice');

function video(id) {
  return { _id: id, title: id };
}

describe('three lane merge', () => {
  it('keeps keyword order, then agent-only ids, then rag-only ids', () => {
    const merged = mergeThreeLanes(
      [video('keyword')],
      [video('agent'), video('keyword')],
      [{ video: video('rag'), cosine: 0.9 }, { video: video('agent'), cosine: 0.99 }],
    );
    assert.deepEqual(merged.map((item) => item._id), ['keyword', 'agent', 'rag']);
  });

  it('reports agent failure before semantic failure', () => {
    assert.equal(decideThreeLaneNotice({ agentFailed: true, embedError: true }), 'agent_unavailable');
    assert.equal(decideThreeLaneNotice({ embedError: true }), 'semantic_unavailable');
    assert.equal(decideThreeLaneNotice({ overCap: true }), 'semantic_unavailable');
    assert.equal(decideThreeLaneNotice({ indexed: 0, expected: 2 }), 'semantic_unavailable');
    assert.equal(decideThreeLaneNotice({ indexed: 1, expected: 2 }), 'coverage_incomplete');
    assert.equal(decideThreeLaneNotice({ indexed: 2, expected: 2 }), '');
  });
});
