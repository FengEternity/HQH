# 运营入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录过的微信在「我的」看到运营工作台；冷启动仍靠指向登录页的小程序码，首页标题连点 8 次保留。

**Architecture:** 「我的」每次显示时读本机已有的 `hqh_admin_ticket`。有字符串才渲染一行，点击进入现有登录页。登录页继续负责有效票据进工作台、无效票据留在口令页。不新增存储键，不生成小程序码。

**Tech Stack:** 微信小程序页面、`node --test`、README。

## Global Constraints

- 从 `dev` 迁出 `dev-admin-entry` 再改。不要在 `main` 上提交。
- 票据键保持 `hqh_admin_ticket`。不新增标记，过期不删除。
- 入口文案是「运营工作台」，右侧是「进入」，样式用现有 `hub-item`。
- 点击进入 `/pages/admin/login/login`。
- 不改口令、票据有效期、云函数、管理页鉴权、工作台、关于页、客服页和 `miniprogram/utils/api.js`。
- 不在小程序里生成、保存或分享码，也不把入口放进底栏。
- 没有票据时不渲染这一行。底部版本不能点。
- 首页标题连点 8 次仍打开登录页。
- 不升版本号。

规格：`docs/superpowers/specs/2026-10-22-admin-entry-design.md`

## File structure

- `miniprogram/pages/mine/mine.js`：读票据，决定 `showAdmin`，打开登录页。
- `miniprogram/pages/mine/mine.wxml`：资料卡和版本之间的条件行。
- `miniprogram/pages/mine/mine.test.js`：无票据隐藏、有票据进入登录页、版本不可点。
- `miniprogram/pages/index/index.test.js`：锁住现有的 8 次点击。不改 `index.js`。
- `README.md`：三条入口。小程序码本身不进仓库。

---

### Task 1: 「我的」里的运营工作台

**Files:**
- Modify: `miniprogram/pages/mine/mine.js`
- Modify: `miniprogram/pages/mine/mine.wxml`
- Test: `miniprogram/pages/mine/mine.test.js`

**Interfaces:**
- Consumes: `getTicket()` from `miniprogram/utils/api.js`，返回本机票据字符串，没有时是 `''`。
- Produces: 页面数据 `showAdmin: boolean`。`openAdmin()` 调用 `wx.navigateTo({ url: '/pages/admin/login/login' })`。

- [ ] **Step 1: 从 dev 迁出分支**

```bash
git checkout dev
git checkout -b dev-admin-entry
```

- [ ] **Step 2: 写失败测试**

在 `miniprogram/pages/mine/mine.test.js` 的 `describe('mine page')` 里追加：

```javascript
  function wxForMine({ ticket, urls }) {
    return {
      getStorageSync(key) {
        return key === 'hqh_admin_ticket' ? ticket : '';
      },
      cloud: {
        callFunction() {
          return Promise.resolve({ result: { ok: true } });
        },
      },
      navigateTo({ url }) {
        urls.push(url);
      },
    };
  }

  it('hides the ops row when this device has no admin ticket', async () => {
    const page = loadPage();
    global.wx = wxForMine({ ticket: '', urls: [] });
    await page.onShow();
    assert.equal(page.data.showAdmin, false);
  });

  it('shows the ops row and opens admin login when a ticket is stored', async () => {
    const urls = [];
    const page = loadPage();
    global.wx = wxForMine({ ticket: 'expired.sig', urls });
    await page.onShow();
    assert.equal(page.data.showAdmin, true);
    page.openAdmin();
    assert.deepEqual(urls, ['/pages/admin/login/login']);
  });
```

把现有 wxml 测试里的 footer 断言保留，并在它前面加上：

```javascript
    assert.equal(wxml.includes('运营工作台'), true);
    assert.equal(wxml.includes('wx:if="{{showAdmin}}"'), true);
    assert.equal(wxml.includes('bindtap="openAdmin"'), true);
    assert.equal(wxml.includes('class="hub-item"'), true);
    assert.equal(wxml.indexOf('运营工作台') < wxml.indexOf('version-foot'), true);
```

`loadPage` 保持现有写法。`wxForMine` 放在 `describe` 内部、两个新测试之前。

- [ ] **Step 3: 确认新测试失败**

Run: `node --test --test-name-pattern 'ops row' miniprogram/pages/mine/mine.test.js`

Expected: FAIL。`showAdmin` 不是 `false`/`true`，或 `openAdmin` 不存在。

- [ ] **Step 4: 实现「我的」入口**

`miniprogram/pages/mine/mine.js` 的引用改为：

```javascript
const { ticketing, getTicket } = require('../../utils/api');
```

`data` 增加 `showAdmin: false`。`onShow` 在请求资料之前写入可见性：

```javascript
  onShow() {
    const doc = normalizeDoc(release);
    this.setData({
      version: doc.version,
      showAdmin: Boolean(getTicket()),
    });
    return ticketing({ action: 'csGetProfile' })
      .then((result) => this.applyProfile(result))
      .catch(() => {});
  },
```

新增：

```javascript
  openAdmin() {
    wx.navigateTo({ url: '/pages/admin/login/login' });
  },
```

`miniprogram/pages/mine/mine.wxml` 在资料卡结束和 `version-foot` 之间插入：

```xml
  <view wx:if="{{showAdmin}}" class="hub-item" bindtap="openAdmin">
    <view class="tile-title">运营工作台</view>
    <text class="muted">进入</text>
  </view>
```

不改 `mine.wxss`。`hub-item` 已在 `miniprogram/app.wxss`。

- [ ] **Step 5: 确认「我的」测试通过**

Run: `node --test miniprogram/pages/mine/mine.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add miniprogram/pages/mine/mine.js miniprogram/pages/mine/mine.wxml miniprogram/pages/mine/mine.test.js docs/superpowers/specs/2026-10-22-admin-entry-design.md
git commit -m "$(cat <<'EOF'
feat(mine): 登录过的微信在「我的」显示运营工作台

EOF
)"
```

---

### Task 2: 锁住首页标题连点

**Files:**
- Test: `miniprogram/pages/index/index.test.js`
- Do not modify: `miniprogram/pages/index/index.js`

**Interfaces:**
- Consumes: 现有 `onTitleTap()`。第 8 次调用 `wx.navigateTo({ url: '/pages/admin/login/login' })`，并把 `tapCount` 归零。

- [ ] **Step 1: 写表征测试**

在 `miniprogram/pages/index/index.test.js` 末尾追加：

```javascript
describe('admin entry gesture', () => {
  it('opens admin login on the eighth title tap', () => {
    const urls = [];
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));
    global.wx = {
      navigateTo({ url }) {
        urls.push(url);
      },
    };
    for (let i = 0; i < 7; i += 1) page.onTitleTap();
    assert.deepEqual(urls, []);
    page.onTitleTap();
    assert.deepEqual(urls, ['/pages/admin/login/login']);
    assert.equal(page.tapCount, 0);
  });
});
```

- [ ] **Step 2: 确认测试通过且不改页面**

Run: `node --test --test-name-pattern 'eighth title tap' miniprogram/pages/index/index.test.js`

Expected: PASS。若失败，停止，不要改连点次数或路径。

- [ ] **Step 3: 提交**

```bash
git add miniprogram/pages/index/index.test.js
git commit -m "$(cat <<'EOF'
test(index): 锁住首页标题连点八次进入运营登录

EOF
)"
```

---

### Task 3: 写明三条入口

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-22-admin-entry-design.md`

**Interfaces:**
- Consumes: Task 1 的「运营工作台」和 Task 2 的登录路径。无新函数。

- [ ] **Step 1: 替换 README 运营入口的第一条**

把「路径：`pages/admin/login/login`，或在首页品牌行连点 8 次。」换成：

```markdown
- 三条路都进 `pages/admin/login/login`：
  - 已发布版本：小程序码或能指定页面路径的小程序链接，路径填 `pages/admin/login/login`，只发给运营。这种码打开的是已发布代码。公众平台的码若不能填路径，就用能指定路径的链接。
  - 本机「我的」：这台微信成功登录过运营后，资料卡和版本之间出现「运营工作台」。票据过期后这一行仍在，点进去重新输口令。清除小程序缓存后，要再用码或连点登录，这一行才回来。
  - 首页标题连点 8 次。体验版在对应正式版发布前用这一条。
```

口令、内容运营、商品运营、品牌改名各条不动。

- [ ] **Step 2: 把规格状态改为已实现**

`docs/superpowers/specs/2026-10-22-admin-entry-design.md` 的「状态：待实现」改为「状态：已实现」。

- [ ] **Step 3: 对照验收阅读**

确认 README 同时写有小程序码或指定路径的链接、本机「我的」、首页标题连点 8 次。确认没有加入生成码的步骤。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/superpowers/specs/2026-10-22-admin-entry-design.md
git commit -m "$(cat <<'EOF'
docs: 写明运营的三条入口

EOF
)"
```
