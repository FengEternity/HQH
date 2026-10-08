---
name: hqh-video-ingest
description: Use when preprocessing and importing local survey-instrument videos into the HQH videos collection for search and video_doc Q&A
---

# HQH 讲解视频入库

## 权威入口

先读取并遵循：

- `scripts/video-ingest/README.md`：所有具体命令、凭据、幂等和失败恢复的唯一来源。
- `docs/superpowers/specs/2026-09-14-video-kb-ingest-asr-design.md`：数据契约、隐私边界和验收标准。

不要在 skill 中推断或重写命令；执行时以 README 当前内容为准。

## 流程判断

1. 确认用户提供的本地视频目录，并按 README 完成本地依赖与 ASR 环境初始化。
2. 按 README 依次完成预处理、ASR、步骤 intro 审核应用和 dry-run。
3. 检查 manifest、dry-run 计划及下列硬停止条件。
4. 只有 README 规定的凭据、目标环境、部署版本、导入闸门和 manifest 备份全部确认后，才允许执行 CloudBase 草稿导入。

## 换素材目录的前置动作

- `scripts/video-ingest/content.zh-CN.json` 没登记过的标题会让 `preprocess` 整批失败、不写 manifest。先按 README 把新标题的 `tags` / `intro` / `modelName` 补进该文件，再重跑；不要放宽校验或编占位文案绕过。
- 排除哪些片子（`_副本`、同题不同编码、按文件名归品牌）是写死在 `lib/manifest.js` 的项目规则，不是自动语义去重。换批素材要人工复核清单；要改就改代码并补测试。

## 硬停止条件

- 未完成去重或媒体不是 H.264 + AAC：停止导入。
- `transcription.status` 不是 `ready`、字幕为伪造/手写全文，或 `introStatus` 不是 `reviewed`：拒绝对应条目。
- intro 的步骤句必须逐句有出处：多数句命中本条字幕，少量界面词靠审核稿显式申报的关键帧证据。这只证明词出现过，不是事实核验，仍需人工抽检；禁止把人工审核说成自动核验。
- 未先通过 dry-run：禁止 execute。
- 云凭据缺失、目标环境未确认或 `catalog` 未部署当前版本：停在 prepared 数据包，不声称已上传。
- manifest 未备份、丢失，或存在无 `videoId` 的 `draft.status=inflight`：禁止自动 execute 或重试，先人工核对。
- 关键帧只用于本地 intro 审核：禁止上传、提交 git、注入问答或发送给云端多模态 API。
- 导入只创建 draft：禁止调用 `publishVideo`；上架必须由管理端人工完成。
- 禁止把凭据、环境值、本地运行产物、视频、关键帧、ASR 模型或绝对源路径写入仓库。
