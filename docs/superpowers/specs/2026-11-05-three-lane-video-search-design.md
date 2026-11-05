# 讲解搜索三路召回

日期：2026-11-05  
状态：架构已定。先按本文实现，再改小程序和云函数。  
取代这些句子，其余旧规格仍有效：

- `2026-09-13-unified-search-context-hub-design.md` 第 3 节「搜索框不进入 Agent Core」
- `2026-10-22-hybrid-video-search-scheme.md` 用余弦门槛在召回阶段把结果滤空
- `2026-10-22-hybrid-video-search-interface.md` 里 AI 搜索和关键词搜索都只调 `search`
- `2026-10-23-ai-native-agent-core-design.md` 第 12 节「搜索框继续只调用 `search`」

关键词按钮仍直接调 `search`。`search` 仍不跑 Agent 循环。

---

## 1. 结论

AI 搜索一次请求跑三路召回，各自产出已上架讲解的 id，外层取并集。三路互不等待对方的命中。

1. **关键词召回。** 不进模型。沿用现网：同义词归一后按空格切 token，每个 token 都要出现在 `searchBlob` 里。
2. **RAG 召回。** 不进模型。同一条查询取向量近邻。相似度只排这一路内部的名次，不作为候选能否留下的开关。
3. **LLM 召回。** `agent` 的 `video_search@v1`。模型自己改写查询，多次调用 `find_videos`，看卡片，交出它认定的 id。

`find_videos` 是给这一路反复调用的底层检索。它不调用外层的三路搜索。模型交回的 id 必须出现在本轮某次 `find_videos` 的返回里。

关键词按钮只走第 1 路。播放页 `video_doc` 不挂全库检索。客服以后找片挂同一个 `find_videos`，不另写一套。

---

## 2. 模块

| 模块 | 职责 |
| --- | --- |
| 讲解框 | 关键词按钮调 `search`。AI 搜索调 `agent`，`profileId=video_search`。拿到 `items` 后仍画格子 |
| `search` | 关键词召回、RAG 召回、`find_videos` 的实现。建索引。不跑模型循环 |
| `agent` | `video_search@v1`：并行启动前两路，同时跑第 3 路的模型循环，合并后返回 `items` 和可选的 `notice` |

小程序不合并三路，不直连模型，不读 `search_chunks`。

`video_search` 不写聊天记录，不展示助手正文。渲染结果就是讲解卡片列表。

---

## 3. 一次 AI 搜索

用户点 AI 搜索后，`agent` 在同一次请求里做这三件事：

```text
query
  ├─ 关键词召回 ──────────────┐
  ├─ RAG 召回 ────────────────┼─ 按 §5 去重合并 → items、notice
  └─ video_search 循环        │
        find_videos × 至多 3 次 ┘
```

前两路用用户原句。第 3 路可以把原句改写成短查询再调用 `find_videos`。三路都不把另外一路的命中当作自己的输入。

空白 query 不发请求。讲解页回到品牌货架。

---

## 4. 三路召回

### 4.1 关键词

与现网 `keywordSearch` 相同：`normalize`、同义词按长到短替换、按空格切 token、已上架、`searchBlob` 上 AND。排序仍是标题档、品牌或型号档、其余命中，同档 `publishedAt` 新的在前。

这一路不截断。

### 4.2 RAG

只对 `search_chunks` 里 `ready`、哈希与当前文案一致、维度和模型名都匹配的块计算余弦。按余弦从高到低取最多 8 条。没有向量的片子不进这一路。

低于旧门槛 0.678 的块可以留下。0.678 不再决定这一路是不是 0 条。余弦分不放进 `items`。

已上架超过 500 条时，这一路不跑，按 §6 给出 `notice`。不拿先读到的块冒充全库。

### 4.3 LLM

`video_search@v1` 只挂 `find_videos`。系统提示要求它按用户原句找已上架讲解，可以改写后多次查找，不闲聊。

一轮最多 3 次 `find_videos`，并落在 Agent Core 已有的单轮工具上限和 20 秒预算里。某次返回空，只说明这个词没中，还可以换词再查，直到次数用完或模型停止。

模型给出的 id 列表最多 8 条，顺序保留。渲染器丢掉本轮工具结果里没出现过的 id。

查询先做内容安全检查，与播放页问答相同。拒绝时不调用模型，整次 AI 搜索按失败返回。

---

## 5. `find_videos`

入参是模型写的短查询。出参是卡片，不是三路合并后的 `items`。

| 字段 | 说明 |
| --- | --- |
| `id` | `videos._id` |
| `title` | 标题 |
| `brandName` | 品牌 |
| `modelName` | 型号 |
| `tags` | 标签 |
| `summary` | 一句简介；没有简介时用 `searchAbstract` |

一次最多 8 张卡片。查询经过和关键词相同的 `normalize` 与同义词替换。替换后的整句是 `searchBlob` 的连续子串才命中。因此「账号设置」能命中简介里的「账号设置」，「怎么设置账号」不能。换词是模型的事。

没有命中时返回空卡片列表，不把全库塞进这一次调用。

`find_videos` 不调用 `video_search`，不跑三路合并。

---

## 6. 合并和失败

同一个 id 只留第一次出现的位置。顺序：

1. 关键词命中，保持 §4.1 的顺序。
2. 只有 LLM 召回找到的，按模型给出的顺序。
3. 只有 RAG 找到的，按余弦从高到低。

关键词读库失败：整次 `ok: false`，`code` 为 `FAIL`。界面是「搜索失败，请重试」，不是没找到。

某一路失败时，另外两路的命中照出。`notice` 只取表里先碰到的一档。

| 情况 | `notice` |
| --- | --- |
| LLM 召回超时、报错或内容安全拒绝 | `agent_unavailable` |
| RAG 嵌入失败、维度不对、已上架超过 500，或已上架多于 0 但没有可用向量 | `semantic_unavailable` |
| RAG 跑成了，但可用向量少于本应建索引的条数 | `coverage_incomplete` |
| 三路都跑完且都是 0 条 | 无 `notice` |

没有 `notice` 且 `items` 为空：讲解页显示「没有找到相关视频」。

有 `notice` 且 `items` 为空：不显示「没有找到相关视频」。`agent_unavailable` 显示「AI 召回暂不可用」。`semantic_unavailable` 显示「语义检索暂不可用」。`coverage_incomplete` 显示「语义检索未覆盖全部讲解，结果可能不全」。

有 `notice` 且 `items` 非空：格子照出。`agent_unavailable` 时格子上方写「AI 召回暂不可用，以下为其他结果」。`semantic_unavailable` 沿用「语义检索暂不可用，以下为关键词结果」。`coverage_incomplete` 沿用覆盖不全的那句。

---

## 7. 不挂这套召回的入口

| 入口 | 行为 |
| --- | --- |
| 关键词按钮 | 只调 `search` 的关键词召回。不跑 RAG，不进 `agent` |
| `video_doc@v1` | 只看当前已发布讲解和关联上架商品。没有 `find_videos` |
| `customer_service@v1` | 以后找片挂同一个 `find_videos`。本期不接 |
| 商城 `scene=product` | 本期仍不检索 |

---

## 8. 明确不做

- 不把三路分数合成一个分，不做 RRF。
- 不训练点击或下单排序模型。
- 不用余弦门槛把 RAG 召回滤成 0 条。
- 不让 `find_videos` 调外层 AI 搜索。
- 不在 AI 搜索里展示对话。
- 不改播放页只回答当前片的边界。
