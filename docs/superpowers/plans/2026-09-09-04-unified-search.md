# 统一 AI 搜索服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 云函数 `search` 按 `scene=video|product` 检索；讲解框与商城框都调用它；下架与草稿不得进 C 端主结果。

**Architecture:** 检索纯函数先对内存中的视频/商品片段打分，再由云函数读库后调用。第一期关键词 + 字段；简介/商品文案各算一个片段。`scene=video` 主结果为视频，最多附带 3 个关联上架商品；`product` 相反。理解层可先不做 LLM，用现有 `synonyms` + `expandQuery`；超时降级路径与关键词路径同一函数。

**Tech Stack:** 新云函数 `search`、复用 `catalogSearch` 的 normalize/expand 思路（复制到 `search/lib`，不要从 catalog 目录 require）、`node --test`。

## Global Constraints

- 第一期 `scene` 只有 `video` 与 `product`。
- 不做全局混排首页、不做向量库。
- C 端只搜上架视频与 `shop_products.status=published`。
- 密钥不进 git。Commit 用简体中文。
- 本计划在 **`dev-ai-search`** 上执行（从 `dev` 迁出）；验收后合回 `dev`。

---

### Task 1: 场景过滤与排序纯函数

**Files:**
- Create: `cloudfunctions/search/lib/searchIndex.js`
- Create: `cloudfunctions/search/lib/searchIndex.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `buildVideoFragment(video)` / `buildProductFragment(shopProduct)` — `{ type, id, title, summary, blob }`
  - `runSearch({ scene, query, tokens, videoFragments, productFragments, links })` → `{ items, related }`
  - `items[].type` 在 `scene=video` 时全为 `video`；`scene=product` 时全为 `shop_product`
  - 草稿 `status!=='published'` 的视频、未上架商品不得出现在 `items`
  - `related` 最多 3 条，且必须 published，并来自 `links`（`{ videoId, shopProductId }`）

- [ ] **Step 1: Write failing tests**

夹具：一条 published 视频「对中」、一条 draft；一条 published 商品「脚架」、一条 unpublished。`links` 把对中视频连到脚架。

`scene=video` query「对中」：items 只有视频；related 含脚架。  
`scene=product` query「脚架」：items 只有商品。  
draft 视频标题含「对中」不得进 items。  
空 query：items 为空数组（不抛错）。

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test cloudfunctions/search/lib/searchIndex.test.js`

- [ ] **Step 3: Implement scoring**

blob 含标题、简介、标签、brandName、modelName 或商品名与详情。所有 token 都包含才命中（与现网 catalog AND 语义一致）。

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/searchIndex.js cloudfunctions/search/lib/searchIndex.test.js
git commit -m "$(cat <<'EOF'
feat(search): 按 scene 派生视频或商品检索结果

EOF
)"
```

---

### Task 2: 云函数接入两个搜索框

**Files:**
- Create: `cloudfunctions/search/index.js`、`package.json`、`config.json`
- Modify: `miniprogram/utils/api.js` — `searchFn(data)` 调 `name: 'search'`
- Modify: `miniprogram/pages/index/index.js` — `onSearch` 改 `scene: 'video'`，把返回的 `items` 映射为现有 tile（`_id` 用 `id`）
- Modify: `miniprogram/pages/shop/shop.*` — 增加搜索框，`scene: 'product'`
- Modify: `README.md` 部署 `search`

**Interfaces:**
- Consumes: `runSearch`、`synonyms` 集合、`videos`、`shop_products`、`video_shop_links`
- Produces: `{ ok: true, scene, items, related }`；未知 scene → `BAD_INPUT`

- [ ] **Step 1: index.js 读库后调用 runSearch**

无结果：`items: []`，不伪装错误。读库失败返回 `ok: false`。

- [ ] **Step 2: 讲解无结果文案保持现网；商城无结果提示换词或去讲解 tab**

- [ ] **Step 3: 回归**

Run: `node --test cloudfunctions/search/lib/searchIndex.test.js cloudfunctions/catalog/lib/catalogSearch.test.js`

手测：下架商品不能被商城搜到；讲解搜视频。

- [ ] **Step 4: Commit**

```bash
git add cloudfunctions/search miniprogram/utils/api.js miniprogram/pages/index/index.js miniprogram/pages/shop README.md
git commit -m "$(cat <<'EOF'
feat(search): 讲解与商城搜索框接入统一检索

EOF
)"
```
