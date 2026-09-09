# 测绘仪器讲解小程序（第一期）

当前版本：**0.1.0**（体验版：空目录、运营后台可建品牌/视频，首页可联系客服留言）。

运营主体：**优度（杭州）智能装备有限公司**（简称「优度」）。产品对外名称是「仪器讲解资料馆」，和执照上的公司全称不是同一个字段。

注册微信小程序时：主体类型选企业，主体名称按执照逐字填写「优度（杭州）智能装备有限公司」（使用中文括号）。小程序名称可另起，不必与公司名相同。

微信小程序 + 微信云开发。目录与关键词搜索已落地；本机可开 **AI 搜**（问句改写 + 语义召回 + 跳段落），不经过微信云函数。

需求与实现计划：`docs/plans/2026-08-29-001-feat-survey-instrument-miniprogram-search-plan.md`

## 没有 AppID 时怎么开发

开发阶段可以先**不配云、不填 AppID**。

1. 微信开发者工具导入本仓库；可用游客模式，也可填真实 AppID。
2. 默认 `miniprogram/config.js` 里 `useLocalCatalog: true`，走本地目录库 `miniprogram/data/catalog.js`（**当前是空库**，品牌和视频都在运营页里新建）。未开通云开发时不要改成 `false`，否则会报 `-601034`。
3. 空库时首页显示「资料馆还是空的」，先进运营页建品牌、加视频。要在小程序里播本地大文件，先跑下面的本地片源服务。
4. 运营页口令是 `dev`（仅本地模拟，正式云环境用你在云函数里配的 `ADMIN_PIN`）。
5. 游客模式**不能**开通云开发、不能真上传视频。要测云存储和内容安全，需要免费注册一个小程序拿到真实 AppID。

## 本地目录库（先入库、后迁云）

片源文件放在仓库根目录 `视频/`（已 gitignore，不进版本库，约 8GB）。目录元数据在 `miniprogram/data/catalog.js`，现在是空的（`brands`/`products`/`videos`/`synonyms` 全为空数组），封面 `miniprogram/data/posters/` 与转写中间件 `miniprogram/data/asr-work/` 也已清空，只留原片。AI 搜片用的转写/摘要/实体字段规范见 `miniprogram/data/video-ai-fields.schema.json`。

开发者工具里本地模拟数据存在 storage key `hqh_mock_db_v6`，清库后如果还看到旧数据，在「存储」面板清一下缓存或重编译。

口播批量转写（需本机已装 `whisper` 与 `ffmpeg`）：

```bash
node scripts/transcribe-catalog.js
# 可选：WHISPER_MODEL=turbo  WHISPER_DEVICE=cpu
# 只转已上架：node scripts/transcribe-catalog.js --published-only
# 覆盖已有转写：node scripts/transcribe-catalog.js --force
```

本地片源服务（只给小程序提供 `/media`、`/poster`、运营截帧 API 和 AI 搜，**没有浏览器页面**）：

```bash
node scripts/preview-server.js
```

### AI 搜片（本机）

网关须同时提供 OpenAI 兼容的 Chat Completions 与 Embeddings。密钥只放本机环境变量，不要提交。

```bash
export OPENAI_BASE_URL=https://api.openai.com   # 或其它兼容地址，不要末尾斜杠
export OPENAI_API_KEY=sk-...
export OPENAI_CHAT_MODEL=deepseek-chat          # 可选，默认 deepseek-chat
export OPENAI_EMBED_MODEL=text-embedding-3-small # 须与索引时一致
node scripts/embed-catalog.js                   # 生成 miniprogram/data/ai-index.json
node scripts/preview-server.js
```

开发者工具里首页输入问题，点 **AI 搜**（旁边 **搜索** 仍是关键词）。未建索引或缺密钥会明确报错，不会改走普通搜。真机预览访问不了电脑上的 `127.0.0.1`。

在小程序里播本地片：先启动上面的服务，再用微信开发者工具打开工程（已关域名校验）。真机预览时 `127.0.0.1` 指向手机本身，播不了电脑上的 `视频/`，请继续用电脑端开发者工具。

迁云时：把已上架且 `localFile` 有值的片子转成 H.264 mp4（建议 1080p、单文件控制在约 100MB 内），上传云存储，把返回的 `fileID` 填进对应记录的 `videoFileId` / `coverFileId`。重复片和超大原片默认是下架/草稿，不必上传。

企业主体在 [微信公众平台](https://mp.weixin.qq.com) 注册小程序：主体名称填「优度（杭州）智能装备有限公司」。通过后在「开发 → 开发管理 → 开发设置」复制 AppID，填进 `project.config.json`，再按下面步骤开云开发。开发阶段仍可用游客模式，不必等认证完成。

## 本地打开

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
2. 导入本仓库根目录（含 `project.config.json`）。
3. 把 `project.config.json` 里的 `appid` 改成你的小程序 AppID。
4. 开通云开发，创建环境。在开发者工具里把该环境设为当前环境。
5. 在云开发控制台创建集合：`brands`、`products`、`videos`、`synonyms`、`support_messages`。
6. 权限建议：所有集合「仅创建者可读写」或自定义规则禁止客户端写；C 端读已上架视频走云函数，不要对 `videos` 开放全表读草稿。
7. 上传云函数 `catalog`。在该云函数「环境变量」中设置 `ADMIN_PIN`（运营口令）。需要内容安全时开通 `security.msgSecCheck`；本地调试可临时设 `SKIP_CONTENT_CHECK=1`（不要用于正式环境）。
8. 云函数目录执行一次依赖安装：在开发者工具云函数面板对 `catalog` 选择安装依赖（`wx-server-sdk`）。
9. 云就绪后把 `miniprogram/config.js` 的 `useLocalCatalog` 改为 `false`。

## 运营入口

- 路径：`pages/admin/login/login`
- 或在首页品牌行连点 8 次进入登录页。
- 工作流：品牌列表 →（品牌卡片上的「编辑」可改名、改排序、删品牌）→ 某品牌下的视频 → 编辑（标题、简介必填，型号与标签可选，上传封面和视频）。上架必须封面和视频都已传。可下架；删除会二次确认。
- 品牌改名会同步刷新该品牌下视频里的 `brandName` 和搜索索引；品牌下还有视频时不允许删除，先把视频删干净。
- 游客模式口令 `dev`。

## 首页客服入口

首页标题右边「联系客服」进入 `pages/contact/contact`，是淘宝客服那种问答页。开场话术和快捷问题在 `miniprogram/config.js` 的 `contact`：

- `welcome`：开场白。默认是「如您需求的问题没有解决，请联系我完善问题库，并领取账号。」
- `faqs`：底部快捷问题；聊天气泡里也可点「领取账号」。
- `wechatId` / `phone`：点「转人工」时提供复制微信、拨打电话。
- 领取的账号存在本地 `hqh_support_account`，同一设备重复领取会拿到同一组。
- 用户自己打字发送，以及点「没有我要的讲解」「转人工」，会写入留言箱。本地开发存在模拟库；上云后进集合 `support_messages`。运营入口首页「客服留言」可看、点一条标已读。点「领取账号 / 怎么找视频」只走自动回复，不进留言箱。

## 检索单测（不依赖微信）

```bash
node --test cloudfunctions/catalog/lib/catalogSearch.test.js cloudfunctions/catalog/lib/videoPublishGate.test.js cloudfunctions/catalog/lib/aiSearch.test.js
```

## 手测清单

- 草稿视频不能出现在首页、品牌列表和搜索结果中。
- 空库时首页给「资料馆还是空的」，运营首页给「还没有品牌」，都不报错。
- 品牌改名后，用新名字搜索能命中它下面已上架的视频，旧名字搜不到。
- 品牌下有视频时点删除会被拦住并说明原因；视频删空后能删掉品牌。
- 首页「联系客服」进入问答页，开场白是完善问题库并领取账号；可点快捷问题、领取并复制账号。
- 无结果时：关键词搜提示换词或按品牌浏览；AI 搜提示换说法或改用「搜索」。
- 首页「AI 搜」在未建索引或未配密钥时给出明确错误，不回退成关键词结果。
- 运营新增品牌并上架（封面+视频齐全、有简介）后，首页出现该品牌且可搜索到。
- 播放页展示标题、品牌、型号、标签、简介，并能播放云存储视频。

## 不要做的事

- 不要把 AppSecret、云密钥、`ADMIN_PIN`、`OPENAI_API_KEY` 提交进 git。
- 不要在微信云函数里调用大模型（本机 AI 搜走 `scripts/preview-server.js`）。
