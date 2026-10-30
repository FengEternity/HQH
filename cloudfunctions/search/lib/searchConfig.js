'use strict';

// 单条输入上限来自 TokenHub 文本向量接口，按字符计，不是 32k tokens。
// 0.678 来自已上架讲解的试算：该中最低约 0.6785，无关句最高约 0.20。
// 同一品牌的相邻步骤仍可能一起通过。以后要更准时只改这个数，不必重新嵌入。
const EMBEDDING_MODEL = 'kinfra-text-embedding-0.6b';
const EMBEDDING_DIM = 1024;
const COSINE_THRESHOLD = 0.678;
const MAX_INPUT_CHARS = 2000;
const VECTOR_CAP = 500;
// 一条嵌入最多试 3 次。批大小取 1，保证整批能在云函数时限内返回。
const INDEX_BATCH_SIZE = 1;

module.exports = {
  COSINE_THRESHOLD,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  INDEX_BATCH_SIZE,
  MAX_INPUT_CHARS,
  VECTOR_CAP,
};
