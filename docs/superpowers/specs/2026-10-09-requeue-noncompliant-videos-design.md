# 把未达播放规格的已有视频重新入队

状态：已实现。用户已同意按此处理已上传视频，含已上架课程。

对照：`docs/superpowers/specs/2026-10-08-cloud-transcode-design.md`。该文档里「不把已上架旧课批量重转」只约束当时那次上线，不约束本设计。

## 1. 要解决什么

新上传会在云托管里先检查、不合格再转码。已经在库里的视频不会自动再走一遍。其中未标成 `media.playback.compliant === true` 的片子仍可能是长关键帧间隔等不合格文件，手机播放会卡。

本设计只补一次入队：有视频文件、且播放检查不是合格的记录，交给已经部署的 `video-ingest`。检查和转码参数不另写。

## 2. 入队范围

管理端一次调用，分页读完 `videos`。每条按下面处理：

- 没有 `videoFileId`：跳过。
- `media.playback.compliant === true`：跳过，不下载、不转码。
- `ingest.phase` 已是 `queued` 或 `running`：跳过。
- 其余：走现有 `enqueueVideo`。`status`、简介、字幕、封面都不变。

入队全部结束后只唤醒一次 `video-ingest`。唤醒失败不撤销已经入队的任务，定时触发器会再叫。

## 3. 处理结果

沿用现有 worker：

- 下载后检查已经合格：不产生新文件，`videoFileId` 不变，回写 `media.playback.compliant === true`。
- 不合格：转成播放规格，成功后把 `videoFileId` 换成 `video/processed/` 下的新文件，再删除被替换的那一个原文件。删除失败只记警告。
- 解不开或转码失败：`phase=failed`，`videoFileId` 不变。

已上架记录保持原 `status`，不自动下架，也不自动上架。`introSource` 为 `human` 的简介不改。云端镜像没有转写模型，转写失败时保留已有简介和字幕。

同一时间仍然只转一条。本设计不改播放页、临时链和小程序包。

## 4. 验收

- 已上架、且 `playback.compliant` 不是 `true` 的记录被入队，上架状态不变。
- `playback.compliant === true` 的记录不被入队。
- 检查后已经合格的文件不被重编码。
- 不合格文件转完后 `playback.compliant === true`，播放文件位于 `video/processed/`。
- 手写简介保持原样。
- 单测不连接真实云环境。
