# 仪器讲解资料馆：商城与 AI Native — 计划索引

规格已定稿：`docs/superpowers/specs/2026-09-09-survey-instrument-ai-native-mall-design.md`。实现按本索引拆成 6 份计划，不要一次改完所有云函数。代码与计划执行都在 **`dev`** 上做，不要在 **`main`** 上开发（`docs/branching.md`）。

| 顺序 | 计划文件 | 独立验收 |
| --- | --- | --- |
| 1 | `2026-09-09-01-tabbar-shell.md` | 底栏四 tab；讲解仍能搜播；商城/我的为空态壳；客服用现网问答页进 tab |
| 2 | `2026-09-09-02-shop-catalog.md` | 可售 SKU、与视频多对多、C 端商城列表/详情、运营商品 |
| 3 | `2026-09-09-03-cart-pay-orders.md` | 购物车、微信支付、订单三态、「我的」 |
| 4 | `2026-09-09-04-unified-search.md` | 云函数 `search`；讲解/商城搜索框改走统一服务 |
| 5 | `2026-09-09-05-player-video-doc-agent.md` | pi-agent-core；播放页下方 `video_doc` |
| 6 | `2026-09-09-06-cs-agent-human.md` | 客服 `cs` profile、转人工、订阅消息、运营工单 |

执行某一份时：REQUIRED SUB-SKILL 为 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。
