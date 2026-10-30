# 讲解搜索对外接口

状态：讨论稿，2026-10-22。给 Mentor 看拆分结果。还没替换 `2026-10-21-hybrid-video-search-design.md`。

内部怎么检索、怎么建索引，写在 `2026-10-22-hybrid-video-search-scheme.md`。那边可以改。这份只写发布后小程序必须照着调用的契约。

云函数名：`search`。身份只用云函数里的微信上下文。客户端不传 openid。

---

## 1. 搜索

讲解栏点搜索时调用。以后 Agent 要找一批讲解，tool 也用这一份入出参，不再另做一套。

搜索栏不传 `action`、`ticket`、`videoId`。空白输入不发请求，讲解页自己回到品牌货架。

### 1.1 入参

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `scene` | 是 | string | 讲解栏固定传 `video`。`product` 仍接受，但返回空的 `items`，不跑混合检索。其它取值返回 `BAD_INPUT`，不检索 |
| `query` | 是 | string | 搜索框原文 |

### 1.2 出参

成功时 `ok` 为 `true`。响应里只有下面这些字段。

| 字段 | 类型 | 何时出现 | 说明 |
| --- | --- | --- | --- |
| `ok` | boolean | 总是 | `true` 表示这次请求已经给出确定结果，包括没有命中 |
| `scene` | string | `ok: true` | 回传 `video` 或 `product` |
| `items` | array | `ok: true` | 讲解卡片，字段见 §1.3。`product` 时为空数组 |
| `notice` | string | 语义检索需要向用户说明时 | 见 §1.4。没有这个字段表示按普通搜索结果展示 |
| `code` | string | `ok: false` | 见 §1.5。讲解页按这个值显示固定文案，云函数不另给一句提示 |

### 1.3 `items` 每一项

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 恒为 `video` |
| `id` | string | `videos._id`。讲解页把它当作格子的 `_id` |
| `title` | string | 标题 |
| `coverFileId` | string | 封面 fileId，可为空 |
| `posterUrl` | string | 封面临时链接。换链失败时为空串，格子仍在 |
| `summary` | string | 简介；没有简介时用 `searchAbstract` |
| `brandName` | string | 品牌名 |
| `brandId` | string | 品牌 id。讲解页用它做品牌筛选 |
| `modelName` | string | 型号 |
| `tags` | string[] | 标签 |

点击格子进入现有播放页，参数用 `id`。

### 1.4 `notice` 和搜索栏

| 响应 | 搜索栏 |
| --- | --- |
| 尚未提交 | 沿用现在的品牌货架，不请求 |
| 提交后、返回前 | 列表区 loading，禁止重复提交 |
| `ok: true`，没有 `notice`，`items` 非空 | 画格子，不加说明 |
| `ok: true`，没有 `notice`，`items` 为空 | 「没有找到相关视频」 |
| `notice` 为 `coverage_incomplete` | 无论有没有格子，都写「语义检索未覆盖全部讲解，结果可能不全」。已有结果仍显示 |
| `notice` 为 `semantic_unavailable`，`items` 非空 | 格子上方一行：「语义检索暂不可用，以下为关键词结果」 |
| `notice` 为 `semantic_unavailable`，`items` 为空 | 「语义检索暂不可用」，保留 query，可再搜一次 |
| `ok: false` | 讲解页显示「搜索失败，请重试」，保留 query，可再搜一次。不画成没有找到 |
| 用户又点了某个品牌 | 仍用同一次返回的 `items`，按 `brandId` 在客户端过滤 |

`notice` 只有 `semantic_unavailable` 和 `coverage_incomplete` 两个值。

### 1.5 失败码

| `code` | 含义 | 讲解页 |
| --- | --- | --- |
| `BAD_INPUT` | `scene` 缺失或不是 `video` / `product` | 「搜索失败，请重试」 |
| `FAIL` | 读讲解或索引数据超时、抛错，或其它未分类失败 | 「搜索失败，请重试」。读库失败不能显示成空库 |

两句都写在讲解页里。用户能做的事相同：保留已输入的词，再搜一次。云函数不返回 `message`。

语义检索没跑成不是这张表里的错误。那种情况 `ok` 仍为 `true`，用 `notice` 表示。

---

## 2. 这份契约里没有的东西

下面这些都不出现在本节的入参或出参里。内部可以改，不必发一版小程序。

- 分页用的 `limit`、`offset`
- `message`、`mode`、`degraded`、`emptyReason`、`related`、`score`
- `vector`、`lanes`、余弦分、内容哈希、块正文、向量数组
- 索引任务的 `taskId`、`cursor`、`status`

---

## 3. 运营索引口

小程序叫不到。只有云函数之间用运营票调用，用来重建一条或推进一批索引。管理端还没有页面读这些字段，所以这份口在页面接上之前可以改。字段和续跑规则见方案稿。
