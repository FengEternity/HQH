# 购物车、支付与订单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能加购、结算（含收货信息）、微信支付；「我的」只见本人订单；状态仅待付款/已付款/已关闭；无物流字段。

**Architecture:** 金额只在服务端用当前上架 `priceFen` 计算。订单状态机是纯函数，支付回调幂等。微信统一下单与回调放在 `shop` 云函数，密钥仅环境变量。

**Tech Stack:** 微信支付（小程序）、云函数、`node --test`。

## Global Constraints

- 订单状态只允许 `pending_pay`、`paid`、`closed`。禁止已发货等物流态。
- 不信任前端应付额。
- 无库存拦截、无自动退款状态。
- 未登录禁止写购物车/下单。
- 密钥不进 git。Commit 用简体中文。

---

### Task 1: 金额与状态机纯函数

**Files:**
- Create: `cloudfunctions/shop/lib/orderMoney.js`
- Create: `cloudfunctions/shop/lib/orderMoney.test.js`
- Create: `cloudfunctions/shop/lib/orderState.js`
- Create: `cloudfunctions/shop/lib/orderState.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `quoteLines(publishedProductsById, cartLines)` → `{ lines, totalFen }`；任一行商品缺失、非 published、数量非正整数 → 抛 `UNAVAILABLE`
  - `applyPaySuccess(status)` → 仅 `pending_pay` 变为 `paid`；已是 `paid` 返回 `paid`（幂等）；`closed` 抛 `INVALID_STATE`
  - `applyClose(status)` → 仅 `pending_pay` → `closed`；其它抛 `INVALID_STATE`

- [ ] **Step 1: Write failing tests**

覆盖：两行数量 2 和 1、单价 100 和 50 → `totalFen === 250`；下架商品失败；`pending_pay` 支付成功；重复支付成功保持 `paid`；已关闭再支付失败；已付款不可关闭。

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test cloudfunctions/shop/lib/orderMoney.test.js cloudfunctions/shop/lib/orderState.test.js`

- [ ] **Step 3: Implement**

`cartLines` 形如 `[{ shopProductId, quantity, spec }]`。快照在下单时写入订单：`name`、`priceFen`、`quantity`、`coverFileId`、`spec`。

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/shop/lib/orderMoney.js cloudfunctions/shop/lib/orderMoney.test.js cloudfunctions/shop/lib/orderState.js cloudfunctions/shop/lib/orderState.test.js
git commit -m "$(cat <<'EOF'
feat(shop): 订单金额以服务端上架价计算并锁定三态

EOF
)"
```

---

### Task 2: 购物车、地址、下单、回调、我的页

**Files:**
- Modify: `cloudfunctions/catalog/lib/ensureCollections.js` — 追加 `carts`、`orders`、`user_addresses`
- Modify: `ensureCollections.test.js`
- Modify: `cloudfunctions/shop/index.js` — `getCart`、`setCart`、`upsertAddress`、`listAddresses`、`createOrder`、`payNotify`（或微信支付云函数文档中的回调 action）、`listMyOrders`、`getMyOrder`、`closeOrder`、`repayOrder`
- Modify: `miniprogram/pages/shop-detail/shop-detail.*` — 加购、立即买
- Create: `miniprogram/pages/cart/cart.*`、`checkout/checkout.*`（非 tab）
- Modify: `miniprogram/pages/mine/mine.*` — 订单列表
- Create: `miniprogram/pages/order-detail/order-detail.*`
- Modify: `miniprogram/pages/admin/home` + 新建 `admin/orders` 只读列表
- Modify: `README.md`：微信支付商户号与 `SHOP_MCH_*` 类环境变量说明，禁止提交密钥

**Interfaces:**
- Consumes: `quoteLines`、`applyPaySuccess`、`applyClose`、云开发 `wx-server-sdk` 的 `cloud.openid`
- Produces: 订单文档含 `openid`、`status`、`totalFen`、`lines`、`address`、`createdAt`、`wxTransactionId`（可空）

- [ ] **Step 1: 扩展集合单测并实现 CRUD**

`createOrder`：读购物车或立即买行 → `quoteLines` → 写 `pending_pay` → 调微信支付统一下单（封装在 `lib/wxpay.js`，单测用假模块；真密钥只在环境变量）。返回 `payment` 给小程序 `wx.requestPayment`。

`payNotify`：验签后 `applyPaySuccess`，按商户订单号幂等。

- [ ] **Step 2: 小程序结算与我的**

结算页必填姓名、手机、地址。取消支付后订单仍为待付款，详情可重新支付。关闭后不可付。

- [ ] **Step 3: 测试**

Run: `node --test cloudfunctions/shop/lib/orderMoney.test.js cloudfunctions/shop/lib/orderState.test.js cloudfunctions/catalog/lib/ensureCollections.test.js`

手测：沙箱或 0.01 元测试单；「我的」只显示自己的单；后台能看到已付款列表且无运单输入框。

- [ ] **Step 4: Commit**

```bash
git add cloudfunctions/shop cloudfunctions/catalog/lib/ensureCollections.js cloudfunctions/catalog/lib/ensureCollections.test.js miniprogram/pages README.md miniprogram/app.json
git commit -m "$(cat <<'EOF'
feat(shop): 购物车结算与微信支付订单三态

EOF
)"
```
