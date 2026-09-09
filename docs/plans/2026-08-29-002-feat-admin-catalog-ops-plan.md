---
title: Mini Program Admin Catalog Operations - Plan
type: feat
date: 2026-08-29
topic: admin-catalog-ops
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Mini Program Admin Catalog Operations - Plan

## Goal Capsule

- **Objective:** 把小程序隐藏管理页改成「品牌列表 → 品牌下视频 → 编辑」，并补齐简介校验、上架文件门槛、下架与彻底删除。
- **Product authority:** 本计划只覆盖管理端。不改 C 端交互、不做网页 CMS、不接 AI。
- **Execution profile:** 在已有 `catalog` 云函数与 `pages/admin/*` 上改信息架构与写入规则；`touristappid` 走 `miniprogram/utils/mockCatalog.js`。
- **Stop conditions:** 把 `/admin` 网页做成正式后台，或引入型号库 / 隐藏检索栏。
- **Open blockers:** 无。
- **Product Contract preservation:** Product Contract unchanged.

## Product Contract

### Summary

运营在微信小程序隐藏管理页工作，不先做电脑网页后台。首页是品牌列表（可增品牌）。点进某个品牌后，只看到该品牌下的视频，可新建、编辑、下架、彻底删除。每条视频除标题外必须有给人看的文本简介，并配标签；型号只是视频上的一格自由文本，不单独建型号库。草稿在封面和视频文件都齐之前不能上架。

### Problem Frame

当前后台把种子、品牌、同义词、全库视频堆在同一屏，看起来像工具箱而不是工作流。运营真正重复的事是「给某个品牌补一条讲解片」，品牌名单改动很少。没有简介字段会把搜索信号全塞进标题，以后优化检索也没有干净的文本可吃。

### Actors

- A1. 内容运营：维护品牌名单，按品牌入库与上下架视频。
- A2. 测绘从业者（间接）：只看到已上架且文件齐全的视频。

### Requirements

**入口与结构**

- R1. 正式后台只存在于小程序隐藏页；需口令保护。
- R2. 管理信息架构是「品牌列表 → 某品牌下的视频列表 → 单条编辑」，不是全库一张长表。
- R3. 运营可增加品牌；品牌名单出现在设置/列表中，C 端品牌墙只展示至少有一条已上架视频的品牌。

**视频字段**

- R4. 每条视频必须有标题、所属品牌、文本简介；型号/系列可空，且仅为自由文本，不维护独立型号实体。
- R5. 标签为逗号分隔的主题词，供筛选与关键词命中；简介给人读，也进入第一期关键词检索语料。
- R6. 第一期不设「仅检索可见、卡片不展示」的隐藏文案栏；也不把简介拆成用途/步骤/场景等多栏表单。品牌俗称（如 CHCNAV）继续走同义词，不塞进每条视频标题。

**状态与删除**

- R7. 视频有草稿与已上架。草稿对 C 端不可见。
- R8. 上架必须已有可播放视频文件与封面；缺任一则只能留在草稿。
- R9. 运营可将已上架改为下架（回到不可被 C 端看到的状态，记录仍可编辑再上架）。
- R10. 运营可彻底删除一条视频（记录与对应云存储文件一并去掉，不可恢复）；彻底删除与下架分开，彻底删除需二次确认。

**明确不做**

- R11. 不做独立 Web 运营后台作为正式产品。
- R12. 不做型号目录、不做结构化多栏描述、不做检索专用隐藏字段。
- R13. 不在本计划重做 C 端视觉，不引入 AI 搜索。

### Key Flows

- F1. 按品牌入库
  - **Trigger:** 运营拿到一条新讲解视频。
  - **Steps:** 打开管理页 → 进入对应品牌（没有则先加品牌）→ 新建 → 填标题、简介、可选型号与标签 → 上传封面与视频 → 存草稿 → 文件齐后上架。
  - **Outcome:** C 端该品牌下可看到并可搜到该条。

- F2. 改与下架
  - **Trigger:** 文案或片源有误。
  - **Steps:** 进入品牌 → 打开该条 → 修改后保存；或下架使 C 端立即看不到。

- F3. 彻底删除
  - **Trigger:** 片源作废或传错。
  - **Steps:** 二次确认后删除记录与文件；列表中不再出现。

### Acceptance Examples

- AE1. 品牌下只看到本品牌片
  - **Given:** 华测、中海达各有视频。
  - **When:** 运营进入「华测」。
  - **Then:** 列表不含中海达条目。

- AE2. 无简介不能当完整条目
  - **Given:** 只填了标题。
  - **When:** 运营保存。
  - **Then:** 提示缺少简介，不能当成可上架的完整草稿。

- AE3. 没传完不能上架
  - **Given:** 标题与简介已填，封面或视频缺一。
  - **When:** 点上架。
  - **Then:** 拒绝上架，仍为草稿。

- AE4. 下架可恢复，删除不能
  - **Given:** 一条已上架视频。
  - **When:** 先下架再上架，C 端重新可见；若改为彻底删除。
  - **Then:** 删除后 C 端与后台列表均不再有该条。

### Success Criteria

- 运营能在不改小程序版本的前提下，为已有或新品牌补片并上架。
- 后台主路径能用「进品牌 → 改视频」一句话说清，同义词与种子不占主屏。
- 每条可上架内容都有可给后续检索用的简介，而不是只有标题。

### Scope Boundaries

- 同义词维护可留在较深的设置里或继续靠种子，不作为日常主路径。
- 品牌改名、有视频时能否删品牌：第一期默认不可删仍有视频的品牌；空品牌可删。若之后要改名，另开需求。
- 本地 `scripts/preview-server.js` 的 `/admin` 不是本计划交付物。

### Key Technical Decisions

- KTD1. 正式管理端只做小程序隐藏页。 (session-settled: user-directed — chosen over 浏览器 CMS 或双端都做)
- KTD2. 型号是视频上的自由文本。 (session-settled: user-directed — chosen over 型号库)
- KTD3. 描述形态是标题 + 简介 + 标签。 (session-settled: agent-recommended, user asked for a call — chosen over 隐藏检索栏或结构化多栏)
- KTD4. 删除语义同时提供下架与彻底删除。 (session-settled: user-directed)
- KTD5. 上架门槛是封面与视频文件都齐。 (session-settled: user-directed)

### Outstanding Questions

无。品牌改名不在本期。

## Planning Contract

### Key Technical Decisions

- KTD6. 视频 `status` 用 `draft` | `unpublished` | `published`。下架写成 `unpublished`，不要复用 `draft`，列表才能区分「从未上架」和「曾经上架后拿下」。C 端与 `searchPublished` 仍只认 `published`。
- KTD7. `publishVideo` 在改 status 之前校验非空 `intro`、`coverFileId`、`videoFileId`；规则抽到可单测的纯函数（与 `catalogSearch.js` 同级），云函数与 mock 共用。
- KTD8. `adminListVideos` 增加可选 `brandId`；管理列表页必须带品牌，禁止再拉全库当主界面。
- KTD9. `deleteVideo` 先删云存储 `coverFileId`/`videoFileId`（忽略文件已不存在），再删库记录。mock 只删内存记录。
- KTD10. 同义词与 `seed` 不出现在管理主路径；`seed` 可留云函数，页面不放主按钮。同义词 UI 本计划不做。
- KTD11. 不改 `scripts/preview-server.js` 的 `/admin`（R11）。

### High-Level Technical Design

```
login --ticket--> admin home (brands)
                      | add brand (upsertBrand)
                      v
              admin brand videos (?brandId=)
                      | new / edit
                      v
              admin edit (?brandId=&id=)
                      | upsertVideo / publishVideo / unpublishVideo / deleteVideo
                      v
              catalog 云函数 + mockCatalog
```

现有缺口：`publishVideo` 未检查封面/视频；`upsertVideo` 允许空简介；`adminListVideos` 无品牌过滤；无下架/删除 action。编辑页用全库列表找一条。

### Sequencing

U1 写入规则与新 action（可单测）→ U2 小程序三层页面与 mock 对齐 → U3 README 管理路径说明。U2 依赖 U1 的 action 名。

### Assumptions

- 口令登录、票据、`requireAdmin` 保持现状。
- `upsertProduct` 可继续存在，管理 UI 不再调用。
- 有视频的品牌本计划不提供删除接口。

## Implementation Units

### U1. Admin write rules and catalog actions

- **Goal:** 简介必填、上架文件门槛、按品牌列表、下架、彻底删除在云函数与纯函数测试里成立。
- **Requirements:** R4, R7, R8, R9, R10, AE2, AE3, AE4
- **Files:** `cloudfunctions/catalog/index.js`, `cloudfunctions/catalog/lib/videoPublishGate.js` (new), `cloudfunctions/catalog/lib/videoPublishGate.test.js` (new)
- **Approach:** 抽出 `assertReadyToPublish(doc)` 与 `assertVideoDraftFields({ title, intro, brandId })`。新增 `unpublishVideo`、`deleteVideo`。`adminListVideos` 接受 `brandId`。`publishVideo` 先跑 gate 再走现有文本内容安全。删除时调用云存储 deleteFile。
- **Test scenarios:**
  - 缺 intro 的 upsert 返回 BAD_INPUT。
  - 缺封面或视频的 publish 拒绝，status 不变。
  - 齐全则可视为 ready（纯函数 true）。
  - 下架后 status 为 unpublished；published 过滤函数仍排除它（可复用 search 测或 gate 旁的小断言）。
- **Verification:** `node --test cloudfunctions/catalog/lib/videoPublishGate.test.js`
- **Dependencies:** none

### U2. Mini-program admin IA and mock parity

- **Goal:** 运营只走品牌 → 该品牌视频 → 编辑；品牌下看不到其他品牌片。
- **Requirements:** R1, R2, R3, R5, AE1, F1, F2, F3
- **Files:** `miniprogram/app.json`, `miniprogram/pages/admin/home/*`, `miniprogram/pages/admin/videos/` (new), `miniprogram/pages/admin/edit/*`, `miniprogram/utils/mockCatalog.js`, `miniprogram/utils/api.js` (仅当 action 列表需要)
- **Approach:** `home` 改为品牌列表 + 新增品牌输入。新页 `videos` 读 `brandId`，调用 `adminListVideos`，展示状态文案（草稿/已下架/已上架），操作：编辑、上架（仅未 published 且本地能判断文件字段）、下架、删除（`wx.showModal`）。`edit` 从 query 锁定品牌，保存校验简介；不要再用全库 find。mock 实现同样 action 与 intro/publish 规则。
- **Test scenarios:** 无自动 UI 测。手测：两品牌各一条时，华测页不含中海达；删除确认后列表消失。
- **Verification:** 微信开发者工具或 mock 路径走完 F1–F3。
- **Dependencies:** U1

### U3. Operator notes

- **Goal:** README 写清隐藏页路径、口令、品牌优先工作流；不把网页 `/admin` 写成正式后台。
- **Requirements:** R11, R13
- **Files:** `README.md`
- **Approach:** 替换当前「管理首页一屏堆操作」的描述。
- **Test scenarios:** 文档中无「请打开 http://127.0.0.1:8787/admin 运营」。
- **Verification:** 人工读 README 管理节。
- **Dependencies:** U2

## Verification Contract

- 单元：`node --test cloudfunctions/catalog/lib/videoPublishGate.test.js`（可与现有 `catalogSearch.test.js` 一起跑）。
- 手测：tourist 模式 mock 完成 AE1–AE4。
- 回归：现有 `node --test cloudfunctions/catalog/lib/catalogSearch.test.js` 仍通过；C 端仍只见 `published`。
- 不要求改 preview-server。

## Definition of Done

- Product Contract 中管理主路径可在小程序里走通，同义词/种子不在管理首页。
- U1 测试绿灯；mock 与云函数 action 名一致。
- 无网页 CMS 当作交付。
- 未引入型号库或检索隐藏字段。
- 弃用的全库管理列表 UI 已从 `admin/home` 移除。

## Appendix

- Origin: 本文件由 requirements-only 原地 enrichment。父计划 `docs/plans/2026-08-29-001-feat-survey-instrument-miniprogram-search-plan.md` 的 U2 被本计划细化，不在 001 里改页面结构。
- Confidence: 中高。云函数与 mock 入口已核对；独立 codebase scout 未另开子代理（本会话内联阅读）。未跑 `ce-doc-review`。
- 现码：`publishVideo` 在 `cloudfunctions/catalog/index.js` 不检查文件字段；`adminListVideos` 无 `brandId`。
