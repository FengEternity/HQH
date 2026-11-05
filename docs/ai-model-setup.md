# 模型接入、配置与验收

播放页问答、模型连通测试和视频简介走云开发资源点。调用源码是 `shared/ai-runtime/index.js`，对话请求发到 `https://<环境ID>.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions`，提供方固定为 `cloudbase`。腾讯 ASR 仍使用自己的签名和任务接口。搜索向量仍直连 TokenHub 的 `kinfra-text-embedding-0.6b`，不从资源点扣。

## 配置来源

运营工作台「模型」保存 `admin_config/agent_models` 中的 `video_doc`、`customer_service`、`video_intro`。视频容器使用现有服务端 CloudBase 身份读取同一环境中的该文档。客服模型仍只保存配置，未接入自动回复。

模型选择优先级：运营保存的名字 → 场景环境变量 → `TOKENHUB_MODEL` → 默认 `hy3`。场景环境变量分别为 `TOKENHUB_VIDEO_DOC_MODEL`、`TOKENHUB_CUSTOMER_SERVICE_MODEL`、`TOKENHUB_INTRO_MODEL`。问答和客服兼容旧 `AGENT_MODEL_NAME`，优先级低于 TokenHub 配置；完成迁移后可移除。

模型名单是服务端允许选择的候选，不代表账户已经开通，也不代表每个模型已通过工具调用验收。供应商模型列表和实际额度必须在目标账户核验。

## 每个运行环境分别配置

云函数与容器的环境变量不共享。以下配置由部署人员在云端注入，不要求开发机保存线上密钥。

- `agent`：Node.js 18 或以上；配置云开发环境的 `TCB_API_KEY`（控制台 → 环境配置 → API Key，不是 TokenHub 密钥）。环境 ID 优先用 `TCB_ENV_ID`，缺省时用云函数上下文里的环境。需要从工作台验证简介容器时，另配与该容器相同的已有 `ADMIN_PIN`，用于生成绑定探测用途、60 秒有效的服务端签名，不把口令或签名交给小程序。按需要配置场景模型和现有 Forseti 凭据。控制台「生文模型」里要先打开实际会调用的模型，套餐需要是资源点套餐。
- `video-ingest`：配置该运行时的 `TCB_ENV_ID`、`TCB_API_KEY`，以及已有 `TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN`。这些云身份配置用于读取运营模型配置和原有视频任务。ASR 继续使用原有地域和引擎配置。
- 两者应指向同一业务云开发环境，并使用该环境的 API Key。搜索向量仍单独使用 `TOKENHUB_API_KEY`。不要把密钥放进 `admin_config`、小程序、Git 或日志。
- `video-ingest` 关闭公网访问，`/run` 与新增 `/ai/probe` 只通过云开发服务间 `cloud.callContainer` 调用；不要为测试打开公网。`/ai/probe` 还校验上述短时签名，只执行服务端固定短句，不接受外部 prompt、模型、工具或密钥。

简介的独立调用函数不再依赖 ASR 密钥；完整视频处理仍需要现有 ASR 和 CloudBase 身份。模型服务缺配置时应显示未就绪，不能伪装为已连通。

## 发布副本

微信云函数按目录上传，不能在运行时引用仓库外的共享文件。发布副本随对应目录提交并上传：

```bash
node scripts/sync-ai-runtime.js
node scripts/sync-ai-runtime.js --check
```

该脚本把唯一源码同步到 `cloudfunctions/agent/lib/ai-runtime.js` 和 `scripts/video-ingest/lib/ai-runtime.js`。不要单独编辑副本。根目录 Dockerfile 已复制整个 `scripts/video-ingest`，因此包含容器副本；云函数上传目录也包含自己的副本。修改共享层后必须重部署对应消费者。

## 云端验证

1. 在目标环境部署 `agent` 和 `video-ingest`，保留现有数据库管理端权限。在「生文模型」打开要用的模型，并确认套餐为资源点套餐。
2. 已启用运营人员打开「模型」。顶部只报告问答云函数的配置就绪情况；配置就绪不等于连通通过。
3. 点播放页问答旁的「测试」。由 `agent` 在云端通过云开发资源点通道发送固定短句；不依赖本机密钥，也不返回供应商错误正文。
4. 点视频简介旁的「测试」。由已鉴权的 `agent` 调用 `video-ingest /ai/probe`，容器读取已保存的 `video_intro` 模型后实际请求同一资源点通道。页面会标明「视频处理服务可以调用」。这项结果不能由问答云函数的测试替代。
5. 两种固定短句测试都只证明文字连通。再用一条已发布讲解，在真机提问并检查工具读取、回答展示、历史和 Forseti。问答每轮最多执行 5 次固定的只读工具；总模型及工具预算 20 秒，单工具最多 5 秒。工具强制调用时关闭思考，按供应商协议发送 `tool_calls` 和 `tool_call_id`。
6. 再完成一条真实视频任务，检查转写、简介生成、审核状态与运营保存模型一致。简介不自动上架。

缺配置、鉴权失败、额度不足、限流和超时分别处理。调用层只对 429、5xx 有限退避，所有重试共享同一次请求的 deadline；不自动换供应商或模型。向量接口额外校验输入、维度、数值和实际模型，模型更换须重建索引。

本地替身测试可以证明请求格式、配置门禁与错误处理，不能代替上述真实云端和真机验收。

协议依据：[TokenHub Chat Completions](https://cloud.tencent.com/document/product/1823/135872)、[语言模型调用概览](https://cloud.tencent.com/document/product/1823/130079)、[向量模型](https://intl.cloud.tencent.com/zh/document/product/1300/81297)。
