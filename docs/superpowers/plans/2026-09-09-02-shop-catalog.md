# 可售商品与视频关联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运营可维护 `shop_products` 并与视频多对多关联；C 端商城能列表/详情；播放页出关联上架商品，商品页出关联已上架视频。

**Architecture:** 新云函数 `shop` 只处理可售 SKU 与关联。现网 `products` 仍是型号，禁止当支付 SKU。`catalog` 的 `initDb` 顺带幂等创建本计划集合，避免第二套 init。列表/详情只返回 `published`。

**Tech Stack:** 微信云开发、`wx-server-sdk`、`node --test`、现有 admin ticket。

## Global Constraints

- `shop_products` 与目录 `products`（型号）分离。
- C 端不得看到 `unpublished`。
- 上架条件：名称、价格（分，≥0）、主图 fileId。
- 无库存、运费、优惠券。
- 密钥不进 git。Commit 用简体中文。
- 本计划在 **`dev-shop-catalog`** 上执行（从 `dev` 迁出）；验收后合回 `dev`。

---

### Task 1: 上架门闩与关联去重（纯函数）

**Files:**
- Create: `cloudfunctions/shop/lib/shopPublishGate.js`
- Create: `cloudfunctions/shop/lib/shopPublishGate.test.js`
- Create: `cloudfunctions/shop/lib/videoShopLink.js`
- Create: `cloudfunctions/shop/lib/videoShopLink.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `assertShopProductPublishable({ name, priceFen, coverFileId, status })` — `status==='published'` 时缺字段抛 `err.code='UNPUBLISHABLE'`
  - `linkKey(videoId, shopProductId)` — 返回 `` `${videoId}\0${shopProductId}` ``
  - `assertLinkIds(videoId, shopProductId)` — 空字符串抛 `BAD_INPUT`

- [ ] **Step 1: Write the failing tests**

`shopPublishGate.test.js`：草稿（unpublished）允许无主图；published 缺名称或价格或主图则失败；`priceFen` 为 `-1` 失败；`0` 允许。

`videoShopLink.test.js`：空 id 失败；两个非空 id 的 `linkKey` 稳定且左右互换结果不同。

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test cloudfunctions/shop/lib/shopPublishGate.test.js cloudfunctions/shop/lib/videoShopLink.test.js`

- [ ] **Step 3: Implement gates**

`assertShopProductPublishable`：仅当 `status === 'published'` 时检查 `String(name).trim()`、`Number.isInteger(priceFen) && priceFen >= 0`、`String(coverFileId).trim()`。

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/shop/lib
git commit -m "$(cat <<'EOF'
feat(shop): 可售商品上架条件与关联键校验

EOF
)"
```

---

### Task 2: 集合清单与 shop 云函数 CRUD

**Files:**
- Modify: `cloudfunctions/catalog/lib/ensureCollections.js` — `CATALOG_COLLECTIONS` 追加 `'shop_products'`、`'video_shop_links'`
- Modify: `cloudfunctions/catalog/lib/ensureCollections.test.js` — 期望数组含这两项
- Create: `cloudfunctions/shop/package.json`（`wx-server-sdk ~3.0.1`）、`index.js`、`config.json`
- Modify: `miniprogram/utils/api.js` — 增加 `shop(data)` 调 `name: 'shop'`
- Create: 运营页 `miniprogram/pages/admin/shop/shop.*`、`miniprogram/pages/admin/shop-edit/shop-edit.*`（列表、编辑、上架、勾选视频关联）
- Modify: `miniprogram/pages/admin/home/home.*` — 增加「商品运营」
- Modify: `miniprogram/app.json` pages
- Modify: C 端 `pages/shop/shop.*` 调 `listPublishedShop`
- Create: `miniprogram/pages/shop-detail/shop-detail.*`（非 tab，`navigateTo`）
- Modify: `miniprogram/pages/player/player.*` — 请求 `listLinkedShopProducts`，展示卡片，点进详情
- Modify: `README.md` 打开与上云：部署 `shop`；集合权限仅管理端

**Interfaces:**
- Consumes: `assertShopProductPublishable`、`assertLinkIds`、`catalog` 的 `requireAdmin` 模式（复制 `ticket.js` 到 `cloudfunctions/shop/lib/ticket.js` 或抽公共文件并在两个函数里各放一份，禁止跨函数目录 require）
- Produces: `shop` actions：
  - C 端：`listPublishedShop`、`getPublishedShop({ id })`、`listLinkedShopProducts({ videoId })`、`listLinkedVideos({ shopProductId })`（仅 published 视频）
  - 运营：`upsertShopProduct`、`setShopProductStatus`、`setVideoShopLinks({ videoId, shopProductIds })`、`listShopAdmin`

价格字段名：`priceFen`（整数分）。状态：`published | unpublished`。

- [ ] **Step 1: 扩展 ensureCollections 单测并改实现**

现有测试断言 `CATALOG_COLLECTIONS` 全量相等，改为包含原五项再加 `shop_products`、`video_shop_links`。

- [ ] **Step 2: 实现 shop/index.js**

`listPublishedShop`：`where({ status: 'published' })`。  
`getPublishedShop`：找不到或未上架 → `NOT_FOUND`。  
`upsertShopProduct`：写前 `assertShopProductPublishable`。  
`setVideoShopLinks`：先删该 `videoId` 下旧行，再插入新 id（去重）。关联的 `shopProductId` 必须存在。

- [ ] **Step 3: 运营与 C 端页面**

商城列表点条目 `navigateTo` `/pages/shop-detail/shop-detail?id=`。详情展示价格（分转元，一位小数即可）、关联讲解列表（调 `listLinkedVideos`）。播放页在视频信息下展示关联商品，无则隐藏区块。

- [ ] **Step 4: 单测 + 手测**

Run: `node --test cloudfunctions/catalog/lib/ensureCollections.test.js cloudfunctions/shop/lib/shopPublishGate.test.js cloudfunctions/shop/lib/videoShopLink.test.js`

手测：下架商品不出现在商城与播放页；上架后两边互链。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/ensureCollections.js cloudfunctions/catalog/lib/ensureCollections.test.js cloudfunctions/shop miniprogram/utils/api.js miniprogram/pages/admin miniprogram/pages/shop miniprogram/pages/shop-detail miniprogram/pages/player miniprogram/app.json README.md
git commit -m "$(cat <<'EOF'
feat(shop): 可售商品入库并与讲解视频互链

EOF
)"
```
