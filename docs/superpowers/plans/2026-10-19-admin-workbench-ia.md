# 运营工作台页面逻辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台只保留内容运营、商品运营、客服工单，版本收成底部一行；通知进客服工单，重处理进内容运营。

**Architecture:** 转码入口文案抽成纯函数，工作台和内容运营共用。通知的订阅、登记和停止从工作台原样移到客服工单页。不改云函数。

**Tech Stack:** 微信小程序页面、`node --test`。

## Global Constraints

- 工作台只有三行日常工作，底部一行环境加版本。
- 删掉「选择要处理的工作。以后增加模块会放在这一页。」
- 内容运营行点进去始终是内容运营；右侧用 `ingestEntryLabel`。
- 重处理行在品牌加载中和品牌为空时仍可见，点进现有重处理页。
- 通知区在客服工单状态筛选上面，交互与现有工作台通知卡相同。
- 不新增订单入口，不改云函数、订阅额度、入队条件、关于页正文和「我的」关于入口。
- 不升版本号。

规格：`docs/superpowers/specs/2026-10-19-admin-workbench-ia-design.md`

---

### Task 1: 转码入口文案

**Files:**
- Create: `miniprogram/utils/ingestEntryLabel.js`
- Test: `miniprogram/utils/ingestEntryLabel.test.js`

**Interfaces:**
- Produces: `ingestEntryLabel({ running, queued, failed, failedToLoad })` 返回字符串。

- [x] 写失败测试并确认失败
- [x] 实现纯函数并确认通过
- [x] 提交

### Task 2: 工作台只留日常工作

**Files:**
- Modify: `miniprogram/pages/admin/home/home.js`
- Modify: `miniprogram/pages/admin/home/home.wxml`
- Modify: `miniprogram/pages/admin/home/home.wxss`
- Modify: `miniprogram/pages/admin/home/home.test.js`

**Interfaces:**
- Consumes: `ingestEntryLabel`
- 工作台不再导出 `notifyLabelText`，不再调用通知接口。

- [x] 改写工作台测试并确认失败
- [x] 改页面并确认通过
- [x] 提交

### Task 3: 通知移到客服工单

**Files:**
- Modify: `miniprogram/pages/admin/inbox/inbox.js`
- Modify: `miniprogram/pages/admin/inbox/inbox.wxml`
- Modify: `miniprogram/pages/admin/inbox/inbox.wxss`
- Create: `miniprogram/pages/admin/inbox/inbox.test.js`

**Interfaces:**
- Produces: `inbox.js` 导出 `notifyLabelText(templateId, enabled, quota)`

- [x] 把原工作台通知测试迁到客服工单并确认失败
- [x] 搬移通知区并确认通过
- [x] 提交

### Task 4: 内容运营进入重处理

**Files:**
- Modify: `miniprogram/pages/admin/catalog/catalog.js`
- Modify: `miniprogram/pages/admin/catalog/catalog.wxml`
- Create: `miniprogram/pages/admin/catalog/catalog.test.js`

**Interfaces:**
- Consumes: `ingestEntryLabel`
- `openIngest` 进入 `/pages/admin/ingest/ingest`

- [x] 写失败测试并确认失败
- [x] 增加入口并确认通过
- [x] 提交
