# 讲解视频入库脚本

本目录的脚本在本机完成视频预处理、转写、介绍审核和云端草稿导入。要求 Node.js 18+；CloudBase SDK 依赖仅安装在本目录：

```bash
npm ci --ignore-scripts --prefix scripts/video-ingest
```

当前 lock 固定 `@cloudbase/node-sdk 3.18.3`。截至本次验证，`npm ci` 的依赖审计报告为 **1 个 moderate、4 个 high** 传递依赖风险；不要据此声称依赖无漏洞，也不要盲目运行可能引入破坏性变更的 `npm audit fix --force`。该脚本只供受控本机运营使用，每次 `--execute` 前都应重新评估风险，并优先验证可用的 SDK 升级。

## 安全边界

- 无云端凭据时，可以运行 `preprocess`、`transcribe`、`apply-intros` 和 `import --dry-run`。
- `import.js` 默认 dry-run；只有显式传入 `--execute` 才会调用云存储和 `catalog`。
- 执行模式只读取进程环境中的 `TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN`。不要把值写进命令、manifest、配置文件或仓库。
- 执行前先确认 `TCB_ENV_ID` 是目标云开发环境，并确认该环境已部署当前版本的 `catalog`。脚本会先通过 `adminLogin` 获取 ticket，再核验并补齐品牌。
- 脚本只调用 `upsertVideo` 保存草稿，绝不调用 `publishVideo`。导入后须到管理端抽检封面、视频、品牌、介绍和字幕，再人工上架。
- 只有 `transcription.status=ready` 且 `introStatus=reviewed` 的条目可导入；缺少本地封面或视频也会拒绝。

建议通过受控的环境注入工具设置凭据，避免把密钥直接写在 shell 命令行。先运行：

```bash
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --dry-run
```

输出应为脱敏计划，只含相对 prepared 路径和待写草稿 payload。dry-run 中的 `brandId`、`coverFileId`、`videoFileId` 都是占位符，不是可提交给云端的真实值。确认 23 条均可导入后，才可在已验证的目标环境运行：

```bash
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --execute
```

## 幂等与失败恢复

manifest 的 `import` 字段按 `cover`、`video`、`draft` 三个 checkpoint 逐步回写。已成功的 checkpoint 在后续运行中跳过；失败 checkpoint 记录脱敏错误且条目不会标为成功。云端返回草稿 ID 后，条目才写为 `import.status=success`。

**manifest 是 execute 的幂等凭据。** 首次执行前必须备份，执行期间不得删除、覆盖或从旧副本恢复。若 manifest 整体丢失，不可从零重跑 `--execute`，否则脚本无法识别已经上传的文件和已经创建的草稿；应先人工恢复最新备份并核对云端 checkpoint。已有 `draft.videoId` 的失败重试会把该 ID 传回 `upsertVideo`，更新原草稿而不是新增。

调用 `upsertVideo` 前，脚本会先落盘 `draft.status=inflight`。云函数明确返回 `ok: false` 时改记 `failed`，允许修正输入后自动重试；网络异常、超时或成功响应缺少非空 `id` 时结果不确定，继续保留 inflight。下一次运行看到没有 `videoId` 的 inflight 条目会拒绝自动重试；必须先在管理端核对云端是否已有对应草稿，再人工修复 manifest。若 inflight 已有 `videoId`，则可继续用该 ID 幂等更新。

单条本地闸门失败不会中止整批：dry-run 和 execute 都会把它列入 rejected，并继续处理其他合法条目；最终汇总返回非零，提醒运营修复被拒绝条目。闸门不会因此放宽。

导入 payload 明确写入空字符串 `searchAbstract` 和四桶为空的 `entities`，口播只传 `transcriptSegments`；不传手写 `transcript`，由 `catalog` 保存逻辑派生。
