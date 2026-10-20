# 运营新工单改走企业微信持续通知

日期：2026-10-20  
状态：待实现  
载体：微信小程序管理端 `pages/admin/inbox`、云函数 `ticketing`  
范围：把「允许一次、收一条」的一次性订阅，换成企业微信里的持续通知。工单数据、回复和关闭不变。

## 1. 要解决什么

现在的新工单通知使用微信一次性订阅。运营点一次「允许」只增加 1 条额度，发完就要再允许。服务端不能把这个卡片做成打开后一直推送的开关。

运营已经有企业微信。目标是：在企业微信里授权一次之后，只要开关开着，新工单就持续发到他的企业微信，包括他已经退出小程序之后。

## 2. 决定

- 个人消息走企业微信自建应用。
- 运营群走已有群的群机器人。
- 绑定方式是在企业微信里打开小程序，`wx.qy.login` 换一次 `userid`。
- 领取账号、怎么找视频也通知。本次不改自动回复规则，自动回复留到后续 AI 客服一起规划。
- 一条工单在群和个人两路都结束后不再通知；失败的那一路可以在后续用户消息补发。
- 个人开关同时决定两件事：这个人收不收私人消息，以及群消息要不要 @ 他。
- 没人开启时，群和个人都不发。

## 3. 不改什么

- 不申请微信小程序长期订阅模板。
- 不把运营 PIN 绑定成独立账号，不改工单的回复人记录。
- 不改用户侧「客服已回复」订阅。
- 不在通知正文里放用户原话。
- 不把企业 ID、应用 Secret、群机器人地址写入仓库。
- 登录页继续不弹订阅窗，也不登记接收人。
- 不改领取账号、怎么找视频的现有回复文案和状态。自动回复是否改成 AI 客服，不在本次设计里决定。

## 4. 运营看到的开关

入口仍在客服工单页顶部，不回到工作台。标题仍是「接收新工单通知」。说明改为：「开启后，新工单会发到你的企业微信，并在运营群 @ 你。停止后这两处都不再通知你。」

页面显示时调用 `csNotifyConfig`。右侧按下面的顺序：

1. 没有企业微信 `userid`：`未绑定`。
2. `enabled !== true`：`未开启`。
3. 其余：`接收中`。

配置读取失败时不改当前右侧文案。页面初始文案是「未开启」。这不影响工单列表自己的失败提示。

开关是一个真正的开关，不再调用 `wx.requestSubscribeMessage`，也不再调用 `csRegisterNotify`。

是否在企业微信内，以当前环境能否调用 `wx.qy.login` 为准。

- 未绑定，且不能调用 `wx.qy.login`：开关不能打开，toast「请在企业微信中打开后再开启」。
- 未绑定，且可以调用 `wx.qy.login`：把 `code` 交给 `csBindWecom`。成功后变为「接收中」，toast「已开启」。
- 已绑定但未开启：直接调用 `csSetNotify({ enabled: true })`，不重新登录。成功后 toast「已开启」。
- 接收中：调用 `csSetNotify({ enabled: false })`。成功后变为「未开启」。`userid` 保留，下次打开不用重新授权。失败时保留原状态，toast「停止失败」。
- 绑定失败：保持「未绑定」，toast「绑定失败」。

票据无效时仍回到登录页。

## 5. 数据

继续使用 `admin_notify_subscribers`，一个 OpenID 一条。发送只看这两个字段：

| 字段 | 含义 |
| --- | --- |
| `openid` | 当前小程序用户。同一 OpenID 只有一条记录 |
| `enabled` | 私人消息是否开启，以及群消息是否 @ 这个人 |
| `wecomUserId` | 企业微信成员 ID。空字符串表示未绑定 |
| `boundAt` | 最近一次绑定成功的毫秒时间戳 |
| `updatedAt` | 毫秒时间戳 |

`quota`、`templateId`、`lastResult`、`lastErrorCode` 不再参与发送。历史额度不会被换算成企业微信通知。

工单文档 `cs_threads` 增加：

| 字段 | 含义 |
| --- | --- |
| `adminNotifyClaimedAt` | 正在发送时的占用时间。没有则表示没人占用 |
| `adminNotifyGroupAt` | 群这一路已结束的时间。没有则表示还要补发 |
| `adminNotifyGroupResult` | `sent` 或 `skipped` |
| `adminNotifyPersonalAt` | 个人这一路已成功的时间 |
| `adminNotifyPersonalResult` | 成功时为 `sent` |

工单关闭后用户再开口，会新开一条工单。新工单没有这些字段，所以会再通知一次。

## 6. 云函数接口

三个接口都校验运营票据。OpenID 只取 `cloud.getWXContext().OPENID`。OpenID 为空时返回 `BAD_INPUT`，不写库。

### `csNotifyConfig`

返回 `{ ok: true, bound, enabled }`。`bound` 为当前记录有非空 `wecomUserId`。没有记录时 `bound` 为 false，`enabled` 为 false。不返回 `userid` 和 `session_key`。

### `csBindWecom`

入参是企业微信 `wx.qy.login` 的 `code`。服务端用自建应用的 `access_token` 调用 [code2Session](https://developer.work.weixin.qq.com/document/path/91507)。

- `code` 为空、接口失败、没有 `userid`，或返回的 `corpid` 与 `WECOM_CORP_ID` 不一致：不写库，返回 `BIND_FAILED`。
- 成功：写入 `wecomUserId`、`boundAt`，并把 `enabled` 设为 true。返回 `{ ok: true, bound: true, enabled: true }`。
- `session_key` 只留在这次请求里，不落库，不返回给小程序。

### `csSetNotify`

入参是 `enabled` 布尔值。

- 打开时当前记录没有 `wecomUserId`：返回 `UNBOUND`，不改状态。
- 关闭时没有记录：幂等返回 `bound: false`、`enabled: false`。
- 关闭时有记录：只把 `enabled` 设为 false，保留 `wecomUserId`。

## 7. 什么时候发

用户消息写入成功后就调用通知。领取账号、怎么找视频也走这条路径，不因为当前仍是规则回复而跳过。通知抛错只记日志，不回滚工单。

这两类消息会占用该工单的这一轮通知。两路都写下结果之后，同一条工单里的后续消息不再发。

接收人是 `enabled === true` 且 `wecomUserId` 非空的记录。

- 没有接收人：群和个人都不发，不写占用，也不写两路结果。用户下一条消息会再判断。
- 有接收人：群机器人发一条文字，`mentioned_list` 只包含这些 `userid`。自建应用再发一条小程序通知给这些人。点开进入 `pages/admin/ticket/ticket?id=工单ID`。

群文字包含「新工单」、状态「待处理」和本地时间。个人通知的标题是「新工单」，内容项是状态和时间。两路都不包含用户原文。

两路结果都已写下之后，这条工单不再发送。只完成一路时，下一条用户消息只补发还没结束的那一路。

## 8. 失败与并发

同一条工单同时有两条消息时，用条件更新抢 `adminNotifyClaimedAt`。只有抢到的一方发送。占用时间在 120 秒内，另一方直接跳过。超过 120 秒还没写完结果，下一条消息可以重新抢，并只补发还没成功的那一路。

- 群机器人地址未配置：个人消息照常发。群写下 `skipped`，之后不重试群。
- 群发送成功：写下 `sent`。
- 群发送失败：不写群结果。占用在这次流程结束时清掉，下一条用户消息补发群。
- 个人发送成功：写下 `sent`。企业微信返回部分 `invaliduser` 时仍算这一路成功，无效成员只记日志。
- 个人全部无效、接口失败或网络失败：不写个人结果，下一条用户消息补发个人。
- 两路都失败：清掉占用，两路结果都不写。
- 一路成功、一路失败：保留成功那路的结果，清掉占用。

`access_token` 过期时刷新一次并重试这一次发送。Secret、机器人地址和 `session_key` 不写进日志。

## 9. 环境变量

只放在云函数环境里：

| 变量 | 用途 |
| --- | --- |
| `WECOM_CORP_ID` | 企业 ID，并用来核对 code2Session 返回值 |
| `WECOM_AGENT_ID` | 自建应用 ID |
| `WECOM_AGENT_SECRET` | 换取应用 `access_token` |
| `WECOM_MINI_APPID` | 小程序通知里的小程序 appid，与 `project.config.json` 的 appid 相同 |
| `WECOM_GROUP_WEBHOOK` | 运营群机器人地址。空则群这一路记为跳过 |

自建应用必须关联这个小程序，否则不能发小程序通知，也不能用该应用的 Secret 换 `userid`。

## 10. 测试

不调用真实企业微信。HTTP 用测试里的假实现。

`miniprogram/pages/admin/inbox/inbox.test.js`：

- 未绑定且不在企业微信时，不调用登录和绑定。
- 在企业微信里打开开关，才把 `code` 交给 `csBindWecom`，并显示「接收中」。
- 已绑定后打开和关闭只调用 `csSetNotify`。
- 不再调用 `wx.requestSubscribeMessage` 和 `csRegisterNotify`。
- 停止失败时保留「接收中」。

`cloudfunctions/ticketing/lib/csSendFlow.test.js`：

- 领取账号、怎么找视频也会请求通知。
- 进入或保持在待人工、人工处理时也会请求通知。真正发不发，由工单上的两路结果决定。

`cloudfunctions/ticketing/lib/csStore.test.js`：

- 绑定成功写入 `userid` 并开启。失败、企业不一致或空 OpenID 不写库。
- 未绑定不能打开。关闭后保留 `userid`。
- 没人开启时不发送，也不写工单通知结果。
- 有人开启时群消息只 @ 这些人，个人通知发给同一些人。
- 群成功、个人失败时，下一次只补发个人。
- 两路都失败时可以整轮再试。
- 两路都结束后不再发送。
- 并发只有一方抢到发送权。
- 通知函数抛错时工单和消息仍在。

`cloudfunctions/ticketing/lib/wecomNotify.test.js`：

- `code` 能换成 `userid`。
- 个人消息走应用发送，群消息走机器人。
- `access_token` 过期时刷新一次。

## 11. 验收

1. 在企业微信里打开一次开关后，退出小程序，下一条新工单仍能发到这个人的企业微信，并在运营群 @ 他。
2. 他关闭开关后，新的待人工工单不再私信他，也不再 @ 他。另一个开着的人继续收到。
3. 所有人都关闭时，运营群没有这条消息。
4. 两路都结束后，同一条工单里的后续消息不再通知。工单关闭后重新开口，会再通知一次。
5. 领取账号、怎么找视频也会发到企业微信，并在运营群 @ 开着的人。回复文案仍是现在的规则回复。
6. 企业微信接口失败时，工单已经保存。失败的那一路会在用户下一条消息补发，成功的那一路不重复发。
