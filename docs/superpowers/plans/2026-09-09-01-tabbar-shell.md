# 底栏四 Tab 壳层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户端出现底栏「讲解｜商城｜客服｜我的」，默认讲解，现有资料馆搜索与播放不回退；商城与我的先空态，客服沿用现网 `pages/contact/contact`。

**Architecture:** Tab 文案与路径集中在 `miniprogram/constants/tabs.js`，`app.json` 的 `tabBar` 与测试共用同一数据。首页去掉「联系客服」按钮，客服只走底栏。商城/我的是占位页，不调新云函数。

**Tech Stack:** 微信原生小程序、现有 `catalog` 云函数、`node --test`。

## Global Constraints

- 对外名称仍是「仪器讲解资料馆」；底栏顺序固定为讲解、商城、客服、我的。
- 不把 AppSecret、云密钥、`ADMIN_PIN` 提交进 git。
- 现网 `products` 集合仍是型号，本计划不创建可售 SKU。
- 本计划不做支付、搜索云函数、pi-agent-core。
- Commit message 用简体中文，不要写 `DES-*` / `ANAL-*`。
- 本计划在 **`dev`** 上执行，不要在 `main` 上开发（`docs/branching.md`）。

---

### Task 1: Tab 常量与单测

**Files:**
- Create: `miniprogram/constants/tabs.js`
- Create: `miniprogram/constants/tabs.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `TAB_BAR_LIST` — 数组，四项，每项 `{ pagePath, text }`，顺序为讲解、商城、客服、我的；路径分别为 `pages/index/index`、`pages/shop/shop`、`pages/contact/contact`、`pages/mine/mine`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TAB_BAR_LIST } = require('./tabs');

describe('TAB_BAR_LIST', () => {
  it('is four tabs in spec order', () => {
    assert.deepEqual(
      TAB_BAR_LIST.map((item) => item.text),
      ['讲解', '商城', '客服', '我的'],
    );
    assert.deepEqual(
      TAB_BAR_LIST.map((item) => item.pagePath),
      [
        'pages/index/index',
        'pages/shop/shop',
        'pages/contact/contact',
        'pages/mine/mine',
      ],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test miniprogram/constants/tabs.test.js`

Expected: FAIL with `Cannot find module` or `TAB_BAR_LIST` undefined

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';

const TAB_BAR_LIST = [
  { pagePath: 'pages/index/index', text: '讲解' },
  { pagePath: 'pages/shop/shop', text: '商城' },
  { pagePath: 'pages/contact/contact', text: '客服' },
  { pagePath: 'pages/mine/mine', text: '我的' },
];

module.exports = { TAB_BAR_LIST };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test miniprogram/constants/tabs.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniprogram/constants/tabs.js miniprogram/constants/tabs.test.js
git commit -m "$(cat <<'EOF'
feat(web): 固定用户端四 tab 文案与路径

EOF
)"
```

---

### Task 2: 商城/我的占位页与 tabBar

**Files:**
- Create: `miniprogram/pages/shop/shop.js`、`shop.json`、`shop.wxml`、`shop.wxss`
- Create: `miniprogram/pages/mine/mine.js`、`mine.json`、`mine.wxml`、`mine.wxss`
- Create: `miniprogram/assets/tab/` 下讲解/商城/客服/我的的 `*.png` 与 `*-on.png`（81×81，tabBar 必填）
- Modify: `miniprogram/app.json` — `pages` 数组在 `pages/index/index` 之后加入 `pages/shop/shop`、`pages/mine/mine`（`pages/contact/contact` 已存在）；增加 `tabBar`
- Modify: `miniprogram/pages/index/index.wxml` — 删除「联系客服」按钮
- Modify: `miniprogram/pages/index/index.js` — 删除 `openContact`
- Modify: `README.md` — 手测增加底栏四项；联系客服改为底栏

**Interfaces:**
- Consumes: `TAB_BAR_LIST` 的 pagePath/text（手写进 `app.json`，与常量保持一致）
- Produces: `wx.switchTab` 可到达四页；商城空态文案「暂无商品」；我的空态文案「登录后可查看订单」（本计划不接登录支付）

- [ ] **Step 1: 写占位页**

`shop.json` / `mine.json`：`{ "navigationBarTitleText": "商城" }` / `"我的"`。

`shop.wxml`：

```xml
<view class="page"><view class="empty">暂无商品</view></view>
```

`mine.wxml`：

```xml
<view class="page"><view class="empty">登录后可查看订单</view></view>
```

`shop.js` / `mine.js`：空 `Page({})`。

- [ ] **Step 2: 加入 tab 图标**

微信 `tabBar.list` 必须有 `iconPath` 与 `selectedIconPath`。放入 `miniprogram/assets/tab/`，文件名：`explain.png`、`explain-on.png`、`shop.png`、`shop-on.png`、`cs.png`、`cs-on.png`、`mine.png`、`mine-on.png`。可用任意 81×81 PNG；不要提交密钥。

- [ ] **Step 3: 配置 `app.json` 的 `tabBar`**

`tabBar.color` `#6B6B70`，`selectedColor` `#1A1A1A`，`backgroundColor` `#F7F7F8`，`list` 四项与 Task 1 路径、文案一致，图标指向上一步文件。

`pages` 中 tab 页必须登记；`pages/shop/shop` 与 `pages/mine/mine` 加在 `pages/index/index` 之后。

- [ ] **Step 4: 首页去掉联系客服**

删除 `index.wxml` 里 `contact-btn` 整块；删除 `index.js` 的 `openContact`。运营入口仍是标题连点 8 次。

- [ ] **Step 5: 回归现有单测并手测**

Run:

```bash
node --test cloudfunctions/catalog/lib/catalogSearch.test.js cloudfunctions/catalog/lib/videoPublishGate.test.js cloudfunctions/catalog/lib/ensureCollections.test.js miniprogram/utils/videoMedia.test.js miniprogram/constants/tabs.test.js
```

Expected: 全部 PASS

手测：底栏四项；讲解搜索/播放仍可用；点客服进现网问答页（`switchTab`，不要再用 `navigateTo` 打开客服）；商城/我的为空态。

- [ ] **Step 6: Commit**

```bash
git add miniprogram/app.json miniprogram/pages/shop miniprogram/pages/mine miniprogram/assets/tab miniprogram/pages/index/index.wxml miniprogram/pages/index/index.js README.md
git commit -m "$(cat <<'EOF'
feat(web): 用户端改为讲解商城客服我的底栏

EOF
)"
```
