# 测绘仪器讲解小程序

当前线上/体验版能力对应 **0.1.0**：微信云开发目录（品牌/视频）、关键词搜索、运营入库、播放、首页客服留言。

下一期（商城、统一搜索、播放页文档问答、AI 客服）需求在 `docs/superpowers/specs/2026-09-09-survey-instrument-ai-native-mall-design.md`，实现计划索引在 `docs/superpowers/plans/2026-09-09-00-ai-native-mall-index.md`。未合入 `main` 前，下文「打开与上云 / 运营 / 手测」仍以 **0.1.0** 为准。

运营主体：**优度（杭州）智能装备有限公司**（简称「优度」）。产品对外名称是「仪器讲解资料馆」，和执照上的公司全称不是同一个字段。

注册微信小程序时：主体类型选企业，主体名称按执照逐字填写「优度（杭州）智能装备有限公司」（使用中文括号）。小程序名称可另起，不必与公司名相同。

微信小程序 + 微信云开发。0.1.0 浏览、关键词搜索、运营入库、播放走云函数 `catalog`、云数据库和云存储。

一期实现计划（已落地）：`docs/plans/2026-08-29-001-feat-survey-instrument-miniprogram-search-plan.md`

## 分支

**`main`** 只用于发布验证（上传体验版/正式版）。**`dev`** 是集成与联调。功能从 `dev` 迁出 **`dev-<功能>`** 短分支，做完合回 `dev`。发行版缺陷从 `main` 迁出 **`hotfix-<简述>`**，验证后合回 `main` 并同步 `dev`。约定全文：`docs/branching.md`。

## 打开与上云

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)，用真实 AppID 导入本仓库根目录（含 `project.config.json`）。游客模式不能开通云开发、不能上传视频。
2. 开通云开发并创建环境，设为当前环境。
3. 对云函数 `catalog`、`shop` 安装依赖并上传部署；环境变量设置 `ADMIN_PIN`（运营口令，两个函数都要配）。`catalog` 需要内容安全时开通 `security.msgSecCheck`；本地调试可临时设 `SKIP_CONTENT_CHECK=1`（不要用于正式环境）。
4. 启动小程序会调用 `initDb`，幂等创建 `brands`、`products`、`videos`、`synonyms`、`support_messages`，以及商城用的 `shop_products`、`video_shop_links`。也可在云函数测试里传入 `{ "action": "initDb" }`。
5. 集合出现后，在云开发控制台把上述集合权限都改成 **仅管理端可读写**。封面和视频文件在云存储，记录里只存 `coverFileId` / `videoFileId`。

企业主体在 [微信公众平台](https://mp.weixin.qq.com) 注册小程序：主体名称填「优度（杭州）智能装备有限公司」。通过后在「开发 → 开发管理 → 开发设置」复制 AppID，填进 `project.config.json`。

## 运营入口

- 路径：`pages/admin/login/login`，或在首页品牌行连点 8 次。
- 口令是云函数环境变量 `ADMIN_PIN`。登录后进入工作台，再选「内容运营」「商品运营」或「客服留言」。
- 内容运营：品牌列表（点行进视频、点编辑改品牌）→ 某品牌下的视频 → 编辑（标题、简介必填，型号与标签可选，上传封面和视频）。上架必须封面和视频都已传。未选手动封面时，上传视频会用系统缩略图（一般为首帧）。可下架；删除会二次确认。
- 商品运营：可售 SKU（`shop_products`，与目录型号集合分离）入库、上架、勾选关联讲解视频；C 端商城与播放页只展示已上架商品。
- 品牌改名会同步刷新该品牌下视频里的 `brandName` 和搜索索引；品牌下还有视频时不允许删除，先把视频删干净。

## 客服入口

底栏「客服」进入 `pages/contact/contact`（`switchTab`）。开场话术和快捷问题在 `miniprogram/config.js` 的 `contact`。

- 领取的账号存在本机 `hqh_support_account`，同一设备重复领取会拿到同一组。
- 用户自己打字发送，以及点「没有我要的讲解」「转人工」，会写入集合 `support_messages`。运营入口首页「客服留言」可看。点「领取账号 / 怎么找视频」只走自动回复，不进留言箱。

## 检索单测（不依赖微信）

```bash
node --test cloudfunctions/catalog/lib/catalogSearch.test.js cloudfunctions/catalog/lib/videoPublishGate.test.js cloudfunctions/catalog/lib/ensureCollections.test.js miniprogram/utils/videoMedia.test.js miniprogram/constants/tabs.test.js
```

## 手测清单

- 底栏四项为「讲解｜商城｜客服｜我的」，默认打开讲解；商城空态「暂无商品」，我的空态「登录后可查看订单」。
- 草稿视频不能出现在首页、品牌列表和搜索结果中。
- 空库时首页给「资料馆还是空的」，内容运营给「还没有品牌」，都不报错。
- 品牌改名后，用新名字搜索能命中它下面已上架的视频，旧名字搜不到。
- 品牌下有视频时点删除会被拦住并说明原因；视频删空后能删掉品牌。
- 客服从底栏进入问答页（`switchTab`），可点快捷问题、领取并复制账号；首页不再有「联系客服」按钮。
- 无结果时：关键词搜提示换词或按品牌浏览。
- 运营新增品牌并上架（封面+视频齐全、有简介）后，首页出现该品牌且可搜索到。
- 播放页展示标题、品牌、型号、标签、简介，并能播放云存储视频。

## 不要做的事

- 不要把 AppSecret、云密钥、`ADMIN_PIN` 提交进 git。
- 不要在 `main` 上直接开发或提交未经验证的改动（见 `docs/branching.md`）。
