# 运营人员名单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用微信 OpenID 管理管理员与运营名单；管理员可邀请、停用和调整他人角色，普通用户看不到运营入口。

**Architecture:** 三个云函数各带一份相同的纯 `adminStaff` 模块，所有微信端管理动作按服务端微信上下文里的 OpenID 查名单。`catalog` 额外承载首次管理员绑定、人员管理、邀请领取与小程序码生成；无微信上下文的既有视频脚本继续使用受动作白名单约束的服务票据。小程序通过 `adminMe` 决定入口、工作台角色和登录/初始化状态。

**Tech Stack:** 微信小程序原生页面、微信云开发 `wx-server-sdk`、CloudBase 文档数据库、Node.js `node:test`。

## Global Constraints

- 功能分支是从 `dev` 迁出的 `dev-admin-staff`，不要在 `main` 上开发。
- 身份只信任 `cloud.getWXContext().OPENID`，忽略客户端传来的 OpenID。
- 角色只有 `admin`、`operator`；两者都能做内容、商品和工单，只有管理员能管理人员。
- 微信端不使用 `hqh_admin_ticket` 决定入口或鉴权。
- `ADMIN_PIN` 只用于绑定首名管理员，以及无 OpenID 的既有视频脚本换取 12 小时服务票据。
- 服务票据只在 OpenID 为空时有效，只允许计划列出的 `catalog` 视频脚本动作；`shop`、`ticketing` 不接受票据。
- 普通用户的「我的」不显示运营入口；首页标题连点 8 次不再导航。
- 不能停用或降级自己，启用中的管理员不能变成零人。
- 邀请 24 小时有效且只能领取一次；已停用微信不能靠邀请自动恢复。
- 小程序不展示 OpenID，不提供手工输入邀请码。
- 不改内容、商品、工单业务规则，不改顾客资料和通知规则，不升版本号。

规格：`docs/superpowers/specs/2026-10-22-admin-staff-design.md`

---

### Task 1: 人员、初始化与邀请领域规则

**Files:**
- Create: `cloudfunctions/catalog/lib/adminStaff.js`
- Create: `cloudfunctions/catalog/lib/adminStaff.test.js`
- Create: `cloudfunctions/shop/lib/adminStaff.js`
- Create: `cloudfunctions/ticketing/lib/adminStaff.js`
- Modify: `cloudfunctions/catalog/lib/ensureCollections.js`
- Modify: `cloudfunctions/catalog/lib/ensureCollections.test.js`
- Test: `cloudfunctions/catalog/lib/adminStaff.test.js`

**Interfaces:**
- `getAdminState(db, openid)` → `{ initialized, enabled, role }`；无记录返回 `enabled: false, role: ''`。
- `requireStaff(db, openid)` → 启用人员记录；否则抛 `UNAUTHORIZED`。
- `requireAdminRole(db, openid)` → 启用管理员记录；运营抛 `FORBIDDEN`。
- `bootstrapAdmin(db, { openid, pin, expectedPin, now })` → 首名管理员；已有初始化标记抛 `ALREADY_INITIALIZED`。
- `listStaff(db, { openid })` → 当前管理员可见的人员记录。
- `updateStaff(db, { openid, targetOpenid, role, enabled, now })` → 修改别人；自己抛 `CANNOT_EDIT_SELF`，最后管理员抛 `LAST_ADMIN`。
- `createInvite(db, { openid, role, code, now })` → 邀请记录，`expiresAt = now + 24 * 60 * 60 * 1000`。
- `claimInvite(db, { openid, code, now })` → 绑定新人员；按规格抛 `INVALID_INVITE`、`ALREADY_STAFF`、`STAFF_DISABLED`。
- 三份 `adminStaff.js` 字节一致，模块只依赖 Node 标准库与传入的 `db`。

- [ ] **Step 1: 写集合失败测试**

在 `ensureCollections.test.js` 的集合断言中加入：

```javascript
'admin_users',
'admin_invites',
'admin_config',
```

- [ ] **Step 2: 写领域规则失败测试**

在 `adminStaff.test.js` 自建支持 `collection().where().get/count/update`、`doc().get/set/update` 与串行 `runTransaction` 的内存库，覆盖：

```javascript
it('binds the first openid as admin with the correct pin')
it('rejects bootstrap after initialization')
it('rejects a bad bootstrap pin')
it('allows enabled admin and operator through requireStaff')
it('rejects missing and disabled staff')
it('rejects operator from requireAdminRole')
it('does not allow editing self')
it('does not allow removing the last enabled admin')
it('creates a 24 hour one-use invite')
it('claims an invite with its selected role')
it('rejects expired and already used invites')
it('does not reactivate disabled staff through an invite')
it('keeps all three cloudfunction copies byte-identical')
```

错误都设置稳定 `error.code`，不要只断言 message。

- [ ] **Step 3: 确认测试失败**

Run:

```bash
node --test cloudfunctions/catalog/lib/ensureCollections.test.js cloudfunctions/catalog/lib/adminStaff.test.js
```

Expected: FAIL，因为集合与模块尚不存在。

- [ ] **Step 4: 实现最小领域模块与集合**

使用文档 ID 保证唯一：

```javascript
admin_users/{openid}
admin_invites/{code}
admin_config/staff
```

`admin_config/staff` 的 `initialized` 在首次绑定事务中写入；并发绑定都读取、写入同一文档，让冲突重试后只有一个成功。未使用邀请固定写 `usedBy: ''`。

列表排序在模块返回前完成：启用管理员、启用运营、停用人员；同组按 `createdAt`。

复制完整实现到 `shop/lib`、`ticketing/lib`，不要跨云函数目录 require。

- [ ] **Step 5: 确认测试通过**

Run:

```bash
node --test cloudfunctions/catalog/lib/ensureCollections.test.js cloudfunctions/catalog/lib/adminStaff.test.js
```

Expected: PASS，输出无 warning。

- [ ] **Step 6: 提交**

```bash
git add cloudfunctions/catalog/lib/adminStaff.js \
  cloudfunctions/catalog/lib/adminStaff.test.js \
  cloudfunctions/shop/lib/adminStaff.js \
  cloudfunctions/ticketing/lib/adminStaff.js \
  cloudfunctions/catalog/lib/ensureCollections.js \
  cloudfunctions/catalog/lib/ensureCollections.test.js \
  docs/superpowers/specs/2026-10-22-admin-staff-design.md \
  docs/superpowers/plans/2026-10-22-admin-staff.md
git commit -m "feat(auth): 增加运营人员与邀请领域规则"
```

---

### Task 2: catalog 接入微信身份与服务票据

**Files:**
- Create: `cloudfunctions/catalog/lib/adminAccess.js`
- Create: `cloudfunctions/catalog/lib/adminAccess.test.js`
- Modify: `cloudfunctions/catalog/index.js`
- Modify: `cloudfunctions/catalog/config.json`
- Test: `cloudfunctions/catalog/lib/adminAccess.test.js`

**Interfaces:**
- `SERVICE_ACTIONS` 精确包含：

```javascript
[
  'adminListBrands',
  'adminListVideos',
  'claimVideoIngest',
  'completeVideoIngest',
  'noteVideoIntro',
  'replacePlaybackMedia',
  'upsertBrand',
  'upsertVideo',
]
```

- `requireCatalogAccess({ db, openid, action, ticket, pin })`：有 OpenID 时只调 `requireStaff`；无 OpenID 时只允许 `SERVICE_ACTIONS` 且票据有效。
- 新 actions：`adminMe`、`adminListStaff`、`adminUpdateStaff`、`adminCreateInvite`、`adminClaimInvite`。
- `adminLogin`：有 OpenID 时调用 `bootstrapAdmin` 且不返回 ticket；无 OpenID 时保留 `issueTicket`。
- `adminCreateInvite` 返回 `{ ok: true, generated, imageBase64, contentType, message }`；生成失败时邀请仍保留，`generated: false`。

- [ ] **Step 1: 写访问决策失败测试**

覆盖：

```javascript
it('uses staff membership whenever openid is present')
it('does not let a ticket bypass membership for a WeChat caller')
it('allows a valid service ticket only for an allowlisted action without openid')
it('rejects non-allowlisted service actions')
it('rejects service access with no ticket')
```

- [ ] **Step 2: 确认访问测试失败**

Run:

```bash
node --test cloudfunctions/catalog/lib/adminAccess.test.js
```

Expected: FAIL，因为模块不存在。

- [ ] **Step 3: 实现访问模块并通过测试**

模块复用 `adminStaff.requireStaff` 与现有 `ticket.verifyTicket`，不要复制签名算法。

Run:

```bash
node --test cloudfunctions/catalog/lib/adminAccess.test.js
```

Expected: PASS。

- [ ] **Step 4: 接入 catalog actions**

在每次请求中取：

```javascript
const openid = cloud.getWXContext().OPENID || '';
```

所有现有管理动作把 `requireAdmin(event.ticket)` 改为：

```javascript
await requireCatalogAccess({
  db,
  openid,
  action: event.action,
  ticket: event.ticket,
  pin: process.env.ADMIN_PIN,
});
```

人员列表在 `admin_users` 结果上按 OpenID 读取 `cs_profiles`，只返回：

```javascript
{ nickname, role, enabled, createdAt, updatedAt, isSelf }
```

更新接口用目标人员在列表中的稳定 `id` 字段传 OpenID，但页面不渲染这个字段。

`adminCreateInvite` 先用 `crypto.randomBytes(18).toString('base64url')` 创建记录，再调用：

```javascript
cloud.openapi.wxacode.get({
  path: `pages/admin/join/join?invite=${code}`,
  width: 430,
});
```

把返回对象的 `buffer` 转 base64。异常转为 `generated: false` 和「发布后才能生成小程序码」，不要删除邀请或让整个 action 失败。

`config.json` 的 `permissions.openapi` 加 `"wxacode.get"`，保留已有权限。

- [ ] **Step 5: 验证 catalog 与视频脚本测试**

Run:

```bash
node --test cloudfunctions/catalog/lib/*.test.js scripts/video-ingest/*.test.js scripts/video-ingest/lib/*.test.js
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add cloudfunctions/catalog/lib/adminAccess.js \
  cloudfunctions/catalog/lib/adminAccess.test.js \
  cloudfunctions/catalog/index.js \
  cloudfunctions/catalog/config.json
git commit -m "feat(auth): 目录管理接入微信人员身份"
```

---

### Task 3: shop 与 ticketing 接入人员身份

**Files:**
- Modify: `cloudfunctions/shop/index.js`
- Modify: `cloudfunctions/ticketing/index.js`
- Create: `cloudfunctions/shop/lib/adminAccess.test.js`
- Create: `cloudfunctions/ticketing/lib/adminAccess.test.js`

**Interfaces:**
- 两个云函数的 `requireAdmin` 都只接收 `(db, openid)` 并调用 `requireStaff`。
- `shop`、`ticketing` 的任何 ticket 都不能绕过名单。
- `ticketing` 的原同步 `requireAdmin` 变成异步，11 个调用点都必须 `await`。

- [ ] **Step 1: 写静态接线失败测试**

测试读取对应 `index.js`，断言：

```javascript
index.includes("cloud.getWXContext().OPENID")
index.includes("require('./lib/adminStaff')")
!index.includes('verifyTicket(process.env.ADMIN_PIN')
```

`ticketing` 另外抽取每个管理 case 块，断言调用 `await requireAdmin(db, openid)`；`shop` 的四个管理函数也断言相同调用。

- [ ] **Step 2: 确认失败**

Run:

```bash
node --test cloudfunctions/shop/lib/adminAccess.test.js cloudfunctions/ticketing/lib/adminAccess.test.js
```

Expected: FAIL。

- [ ] **Step 3: 完成接线**

两个入口都在 handler 开头读取服务端 OpenID。保留公开 actions。管理 actions 在业务读写之前先查名单。

- [ ] **Step 4: 运行三个云函数测试**

Run:

```bash
node --test cloudfunctions/catalog/lib/*.test.js cloudfunctions/shop/lib/*.test.js cloudfunctions/ticketing/lib/*.test.js
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add cloudfunctions/shop/index.js \
  cloudfunctions/shop/lib/adminAccess.test.js \
  cloudfunctions/ticketing/index.js \
  cloudfunctions/ticketing/lib/adminAccess.test.js
git commit -m "feat(auth): 商品与工单管理校验运营名单"
```

---

### Task 4: 小程序入口、初始化与工作台角色

**Files:**
- Modify: `miniprogram/utils/api.js`
- Modify: `miniprogram/utils/api.test.js`
- Modify: `miniprogram/pages/mine/mine.js`
- Modify: `miniprogram/pages/mine/mine.wxml`
- Modify: `miniprogram/pages/mine/mine.test.js`
- Modify: `miniprogram/pages/index/index.js`
- Modify: `miniprogram/pages/index/index.test.js`
- Modify: `miniprogram/pages/admin/login/login.js`
- Modify: `miniprogram/pages/admin/login/login.wxml`
- Modify: `miniprogram/pages/admin/login/login.test.js`
- Modify: `miniprogram/pages/admin/home/home.js`
- Modify: `miniprogram/pages/admin/home/home.wxml`
- Modify: `miniprogram/pages/admin/home/home.test.js`
- Modify: `miniprogram/pages/about/about.js`

**Interfaces:**
- 新 API `adminMe()` 调 `catalog({ action: 'adminMe' })`，不附加本地票据。
- 微信端 `admin`、`shopAdmin`、`ticketingAdmin` 不再附加 `ticket`；函数名保持，避免改所有调用者。
- Mine `showAdmin` 来自 `adminMe().enabled`，点击直接打开 `/pages/admin/home/home`。
- Login 按 `adminMe` 的 `{ initialized, enabled }` 决定：启用人员进工作台；已初始化的非人员 `switchTab` 回 Mine；未初始化显示口令。
- Home 保存 `role`；只有 `admin` 渲染「人员」并可进入 `/pages/admin/staff/staff`。

- [ ] **Step 1: 写失败测试**

新增/更新断言：

```javascript
api admin wrappers do not read or send hqh_admin_ticket
mine hides row for disabled/unknown and shows it for enabled staff
mine opens home directly
eighth title tap never navigates
login only shows pin before initialization
login bootstraps first admin and enters home
login sends initialized non-staff back with switchTab
home shows staff row only for role admin
home opens /pages/admin/staff/staff
about staff mode checks adminMe instead of local ticket
```

- [ ] **Step 2: 确认失败**

Run:

```bash
node --test \
  miniprogram/utils/api.test.js \
  miniprogram/pages/mine/mine.test.js \
  miniprogram/pages/index/index.test.js \
  miniprogram/pages/admin/login/login.test.js \
  miniprogram/pages/admin/home/home.test.js
```

Expected: FAIL。

- [ ] **Step 3: 实现入口与状态**

Mine 的 `adminMe` 失败按普通用户处理，不 toast。Home 的 `adminMe` 若未启用，`wx.switchTab({ url: '/pages/mine/mine' })`；角色读取失败不显示人员行。

移除 `index.js` 的 `tapCount` 和导航；WXML 可以保留标题普通点击绑定，也可以移除绑定，测试必须证明不会导航。

About 的 `staff=1` 在 `onLoad` 异步调用 `adminMe`；未启用时 `switchTab` 回 Mine，启用后才构建内部更新说明。

- [ ] **Step 4: 确认测试通过**

运行 Step 2 命令，Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add miniprogram/utils/api.js miniprogram/utils/api.test.js \
  miniprogram/pages/mine \
  miniprogram/pages/index/index.js miniprogram/pages/index/index.test.js \
  miniprogram/pages/admin/login \
  miniprogram/pages/admin/home \
  miniprogram/pages/about/about.js
git commit -m "feat(auth): 按微信人员身份显示运营入口"
```

---

### Task 5: 人员管理页与邀请领取页

**Files:**
- Modify: `miniprogram/app.json`
- Create: `miniprogram/pages/admin/staff/staff.js`
- Create: `miniprogram/pages/admin/staff/staff.wxml`
- Create: `miniprogram/pages/admin/staff/staff.json`
- Create: `miniprogram/pages/admin/staff/staff.wxss`
- Create: `miniprogram/pages/admin/staff/staff.test.js`
- Create: `miniprogram/pages/admin/join/join.js`
- Create: `miniprogram/pages/admin/join/join.wxml`
- Create: `miniprogram/pages/admin/join/join.json`
- Create: `miniprogram/pages/admin/join/join.wxss`
- Create: `miniprogram/pages/admin/join/join.test.js`

**Interfaces:**
- Staff actions：`adminListStaff`、`adminUpdateStaff`、`adminCreateInvite`。
- Join action：`adminClaimInvite`，参数 `code`。
- 人员页只渲染 `nickname || '未设置昵称'`、角色、状态；不渲染 id/OpenID。
- 邀请图写入 `${wx.env.USER_DATA_PATH}/admin-invite.png` 后调用 `wx.saveImageToPhotosAlbum`。

- [ ] **Step 1: 写页面失败测试**

Staff 覆盖：

```javascript
loads staff and does not expose openid in wxml
labels admin as 管理员 and operator as 运营
does not offer role/status controls for isSelf
updates another person's role or enabled state
creates an operator invite by default
saves generated base64 QR image to the album
shows 发布后才能生成小程序码 when generated is false
shows 只有管理员能修改人员 and navigates back on FORBIDDEN
switches to Mine on UNAUTHORIZED
```

Join 覆盖：

```javascript
claims the invite from query and redirects to home
shows 邀请无效 for INVALID_INVITE
shows 你已在名单中 for ALREADY_STAFF
shows 需要管理员重新启用 for STAFF_DISABLED
does not render a manual invite input
```

- [ ] **Step 2: 确认失败**

Run:

```bash
node --test miniprogram/pages/admin/staff/staff.test.js miniprogram/pages/admin/join/join.test.js
```

Expected: FAIL，因为页面不存在。

- [ ] **Step 3: 实现并注册页面**

`app.json` 增加：

```json
"pages/admin/staff/staff",
"pages/admin/join/join"
```

角色/状态修改用 `wx.showActionSheet`，危险的停用再用 `wx.showModal` 确认。创建邀请先选角色，再请求。保存相册失败提示「保存失败」，邀请仍有效。

- [ ] **Step 4: 确认页面测试通过**

运行 Step 2 命令，Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add miniprogram/app.json miniprogram/pages/admin/staff miniprogram/pages/admin/join
git commit -m "feat(admin): 增加人员管理与邀请领取页面"
```

---

### Task 6: 未授权回退与文档收尾

**Files:**
- Modify: `miniprogram/pages/admin/catalog/catalog.js`
- Modify: `miniprogram/pages/admin/brand/brand.js`
- Modify: `miniprogram/pages/admin/videos/videos.js`
- Modify: `miniprogram/pages/admin/ingest/ingest.js`
- Modify: `miniprogram/pages/admin/shop/shop.js`
- Modify: `miniprogram/pages/admin/shop-edit/shop-edit.js`
- Modify: `miniprogram/pages/admin/inbox/inbox.js`
- Modify: `miniprogram/pages/admin/ticket/ticket.js`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-22-admin-staff-design.md`

**Interfaces:**
- `UNAUTHORIZED` 的微信页面统一 `wx.switchTab({ url: '/pages/mine/mine' })`，不再回口令页。
- `FORBIDDEN` 在人员页按 Task 5 处理；其他日常业务不应产生该错误。

- [ ] **Step 1: 写静态失败测试**

在最邻近的既有页面测试或新建 `miniprogram/pages/admin/adminUnauthorized.test.js`，读取上述页面脚本，断言不再含：

```javascript
redirectTo({ url: '/pages/admin/login/login' })
```

并断言各自的 `UNAUTHORIZED` 分支含：

```javascript
switchTab({ url: '/pages/mine/mine' })
```

- [ ] **Step 2: 确认失败**

Run:

```bash
node --test miniprogram/pages/admin/adminUnauthorized.test.js
```

Expected: FAIL。

- [ ] **Step 3: 修改回退并更新文档**

README：

- 部署后仍要求三个云函数配置相同 `ADMIN_PIN`，说明它只用于首名管理员和服务脚本。
- 运营入口改为首名管理员初始化、管理员小程序码邀请、本机名单入口；删除首页连点 8 次说明。
- 自动化命令加入 `mine.test.js`、`staff.test.js`、`join.test.js`、`adminUnauthorized.test.js`。
- 数据集合加入 `admin_users`、`admin_invites`、`admin_config`。

规格状态改为「已实现」。

- [ ] **Step 4: 运行完整测试**

Run:

```bash
node --test \
  cloudfunctions/catalog/lib/*.test.js \
  cloudfunctions/shop/lib/*.test.js \
  cloudfunctions/ticketing/lib/*.test.js \
  miniprogram/utils/*.test.js \
  miniprogram/constants/*.test.js \
  miniprogram/pages/contact/contact.test.js \
  miniprogram/pages/admin/login/login.test.js \
  miniprogram/pages/admin/home/home.test.js \
  miniprogram/pages/admin/edit/edit.test.js \
  miniprogram/pages/admin/ticket/ticket.test.js \
  miniprogram/pages/admin/staff/staff.test.js \
  miniprogram/pages/admin/join/join.test.js \
  miniprogram/pages/admin/adminUnauthorized.test.js \
  miniprogram/pages/index/index.test.js \
  miniprogram/pages/mine/mine.test.js \
  scripts/video-ingest/*.test.js \
  scripts/video-ingest/lib/*.test.js
python3 -m unittest scripts/video-ingest/test_transcribe.py
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/superpowers/specs/2026-10-22-admin-staff-design.md \
  miniprogram/pages/admin
git commit -m "docs: 补充运营人员名单部署与验收说明"
```
