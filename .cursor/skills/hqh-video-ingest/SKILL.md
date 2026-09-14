---
name: hqh-video-ingest
description: 指导 HQH 仓库中的本地讲解视频批量预处理、ASR 转写、步骤 intro 审核及 CloudBase draft 导入。适用于用户要求批量处理本地视频、生成问答资料或触发视频草稿入库时。
---

# HQH 讲解视频入库

## 开始前

先读取并遵循：

- `scripts/video-ingest/README.md`：命令、凭据、幂等和失败恢复。
- `docs/superpowers/specs/2026-09-14-video-kb-ingest-asr-design.md`：数据契约、隐私边界和验收标准。

令 `INPUT_DIR` 指向用户明确提供的本地视频目录；运行产物只写入已忽略的 `.video-ingest/prepared`。

## 命令顺序

按顺序执行，不跳步：

```bash
npm ci --ignore-scripts --prefix scripts/video-ingest

node scripts/video-ingest/preprocess.js \
  --input "$INPUT_DIR" \
  --output .video-ingest/prepared

.video-ingest/venv/bin/python scripts/video-ingest/transcribe.py \
  --manifest .video-ingest/prepared/manifest.json \
  --model medium \
  --language zh

node scripts/video-ingest/apply-intros.js \
  --manifest .video-ingest/prepared/manifest.json \
  --reviews .video-ingest/prepared/intros.review.json

node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --dry-run
```

仅在 README 的凭据、目标环境、部署版本、导入闸门和 manifest 备份全部确认后运行：

```bash
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --execute
```

## 硬停止条件

- 未完成去重或媒体不是 H.264 + AAC：停止导入。
- `transcription.status` 不是 `ready`、字幕为伪造/手写全文，或 `introStatus` 不是 `reviewed`：拒绝对应条目。
- 未先通过 dry-run：禁止 execute。
- 云凭据缺失、目标环境未确认或 `catalog` 未部署当前版本：停在 prepared 数据包，不声称已上传。
- manifest 未备份、丢失，或存在无 `videoId` 的 `draft.status=inflight`：禁止自动 execute 或重试，先人工核对。
- 关键帧只用于本地 intro 审核：禁止上传、提交 git、注入问答或发送给云端多模态 API。
- 导入只创建 draft：禁止调用 `publishVideo`；上架必须由管理端人工完成。
- 禁止把凭据、环境值、本地运行产物、视频、关键帧、ASR 模型或绝对源路径写入仓库。
