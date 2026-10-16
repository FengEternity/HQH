# 运营新工单通知订阅

日期：2026-10-16  
载体：现有微信小程序（`miniprogram/` + 云函数 `ticketing`）  
分支：`hotfix-cs-notify`（从当前 `main` 迁出；验证后合回 `main`，并同步到 `dev`）  
范围：多个运营人员共用同一套客服工单，各自决定当前微信是否接收新工单订阅消息。

## 背景

工作台「接收新工单通知」在用户拒绝或订阅失败时仍调用 `csRegisterNotify`。`admin_notify_subscribers` 只保存 OpenID，没有开关和剩余额度。新工单会向该集合里最多 100 条记录逐个发送。

因此会出现：别人点允许却看到「未允许，这个微信收不到通知」，而以前登录或点过该卡片的微信继续收到通知。微信一次性订阅是一次允许对应一条消息；允许结果只存在于当次 `wx.requestSubscribeMessage` 回调，服务端无法事后查询。

对话中已确认：

- 保持单一客服工作区。所有持有效运营票据的人查看、回复、关闭同一套工单。
- 通知接收按微信独立开关，可随时停止。
- 只有微信返回 `accept` 才增加一次额度。
- 历史订阅记录视为未开启，必须重新允许。
- 登录不再弹订阅窗，也不登记接收人。
- 本期不新增独立运营账号，不把登录票据绑定到具体微信。

## 目标

- 拒绝、封禁或订阅调用失败不会把当前微信登记为接收人。
- 每个微信能看到自己的状态：未配置、未开启、还可接收 N 条、额度已用完。
- 停止接收立即对该微信生效，不影响其他运营人员，也不影响工单数据。
- 同一条额度最多发出一条新工单通知。
- 通知失败不回滚已写入的工单。

## 非目标

- 商家、品牌、独立数据库等形式的多租户。
- 独立运营账号、分角色权限、把 `ADMIN_PIN` 票据绑定到 OpenID。
- 把回复记录改成记录具体运营人员。
- 长期订阅模板。继续使用现有一次性新工单模板。
- 用户侧「客服已回复」订阅。该路径维持现状。
- 自动清理或迁移历史订阅文档。旧文档缺少新字段时自然不会被选中。

## 数据

继续使用 `admin_notify_subscribers`，不新建集合。文档字段：

| 字段 | 含义 |
| --- | --- |
| `openid` | 当前微信。同一 OpenID 只有一条记录 |
| `enabled` | 是否愿意接收。停止接收只改这个字段 |
| `quota` | 当前模板剩余可发送次数 |
| `templateId` | 这些额度对应的模板 ID |
| `lastResult` | `sent`、`unsubscribed`、`failed`、`stopped` 之一；新记录可为空字符串 |
| `lastErrorCode` | 最近一次发送失败码；成功或停止后清空 |
| `createdAt` / `updatedAt` | 毫秒时间戳 |

历史文档只有 `openid`、`createdAt`、`updatedAt`。查询条件要求 `enabled === true`，这些文档不会收到通知。

额度与模板绑定。记录中的 `templateId` 必须等于当前环境变量 `CS_NEW_TICKET_TPL` 才可发送。模板更换后，旧额度不换算到新模板。

## 状态显示

工作台进入时调用扩展后的 `csNotifyConfig`。返回当前模板 ID，以及当前 OpenID 的 `enabled`、`quota`。没有记录时二者分别为 `false`、`0`。页面按以下顺序显示右侧状态：

1. 服务端没有模板 ID：`未配置`。点击只提示「未配置通知模板」。
2. `enabled !== true`：`未开启`。
3. `quota > 0`：`还可接收 N 条`。
4. 其余：`额度已用完`。

`enabled === true` 且模板已配置时，卡片内显示「停止接收」。该按钮使用 `catchtap`，不触发整张卡片的订阅。

卡片标题仍为「接收新工单通知」。说明文案为「每次允许只能收一条。停止后不再推送。」

## 客户端

`pages/admin/login/login` 只校验口令、保存票据并进入工作台。删除登录成功后的 `requestSubscribeMessage` 和 `csRegisterNotify`。

`pages/admin/home/home` 点击通知卡片：

- 已有模板 ID 时调用 `wx.requestSubscribeMessage`。
- 回调里该模板 ID 的值是 `accept`：调用 `csRegisterNotify`，再用返回的 `enabled`、`quota` 刷新状态。提示「已开启，还可接收 N 条」。
- 值为 `reject`、`ban`、`filter`，或接口失败：不调用登记接口，不修改额度。提示「未允许，这个微信收不到通知」。

点击「停止接收」调用 `csUnregisterNotify`。成功后状态变为「未开启」。

## 云函数

三个管理接口都沿用现有运营票据校验，OpenID 只取 `cloud.getWXContext().OPENID`。OpenID 为空时返回 `BAD_INPUT`，不写库。

### `csNotifyConfig`

返回 `{ ok: true, newTicketTplId, enabled, quota }`。`newTicketTplId` 仍由 `CS_NEW_TICKET_TPL` 读取。

### `csRegisterNotify`

只由客户端在 `accept` 之后调用。服务端不判断微信弹窗结果。

- 无记录：创建 `enabled: true`、`quota: 1`、`templateId` 为当前模板。
- 已有记录且 `templateId` 相同：`enabled: true`，`quota` 加 1。
- 已有记录但模板不同：改为当前模板，`quota` 设为 1。旧模板额度不保留。

允许成功后清空 `lastResult` 和 `lastErrorCode`。返回 `{ ok: true, enabled, quota }`。

### `csUnregisterNotify`

把当前 OpenID 的 `enabled` 设为 `false`，`quota` 保持不变，`lastResult` 设为 `stopped`，清空 `lastErrorCode`。无记录时幂等返回 `enabled: false`、`quota: 0`。

### 发送

新工单通知仍在工单写入成功后执行，外层捕获异常，失败只记日志。

候选记录分页读取，条件同时为：

- `enabled === true`
- `quota > 0`
- `templateId === 当前模板 ID`

不使用 `orderBy`，避免缺少组合索引时整次查询失败。不先取 100 条再在内存过滤，避免历史记录占满名额。

对每条候选记录：

1. 条件更新预扣：仅当记录仍满足上述三个条件时，`quota` 减 1。更新数为 0 则跳过，不发送。
2. 调用 `subscribeMessage.send`。
3. 成功：`lastResult = sent`，清空 `lastErrorCode`。额度保持已扣减。
4. 异常或返回体中的错误码是数字或字符串 `43101`：`quota` 设为 0，`enabled` 保持 true，`lastResult = unsubscribed`，记录错误码。页面随后显示「额度已用完」。这表示微信侧已无可用授权。
5. 其他发送失败：`quota` 加回 1，`lastResult = failed`，记录错误码。

发送结果先判定，再单独写入结算。结算写入失败只记日志，不再把这次发送改判为失败，也不把额度加回。预扣后进程中断同样会造成一次额度损失。用户再点允许即可补回。本期不做定时对账。

两张工单并发时，同一条额度只能有一次条件更新成功，因此只会发送一次。

## 错误

- 空 OpenID：`BAD_INPUT`，不新增接收人。
- 票据无效：维持 `UNAUTHORIZED`，工作台回到登录页。
- 模板未配置：不调用微信订阅，也不发送；工单写入照常成功。
- 订阅或停止接口失败：工单与登录都不回滚。停止失败时保留原状态并提示失败。

## 测试

`miniprogram/pages/admin/login/login.test.js`：

- 登录成功后直接进入工作台。
- 不调用 `requestSubscribeMessage`，也不调用 `csRegisterNotify`。

`miniprogram/pages/admin/home/home.test.js`：

- `accept` 才登记，并显示返回的剩余额度。
- `reject`、`ban` 和订阅失败不登记。
- 模板为空时不弹订阅窗。
- 停止接收调用 `csUnregisterNotify`，成功后显示「未开启」。
- 停止按钮不触发订阅。

`cloudfunctions/ticketing/lib/csStore.test.js`：

- 首次允许创建额度 1；同一模板再次允许变为 2。
- 更换模板后额度变为 1，模板 ID 改为新值。
- 停止后 `enabled` 为 false，额度不变。
- 缺少 `enabled` 的历史记录不会进入候选。
- 并发预扣只有一次成功。
- 发送成功保持扣减；`43101` 归零；其他失败把额度加回。

工单写入测试继续断言通知函数抛错时线程和消息仍保留。

## 验收

1. 一个微信点拒绝，另一个已开启的微信仍能收到下一条；拒绝的微信收不到。
2. 点允许一次后收到一条，第二条在再次允许前不再发给这个微信。
3. 点停止接收后，立即不再向这个微信发送；工单仍在「客服工单」中。
4. 以前登录过、但没有按新规则重新允许的微信不再收到通知。
5. 模板缺失、微信返回 `43101`、其他发送失败时，工单都已保存。
