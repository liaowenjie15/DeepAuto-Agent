# Grain Niuma 飞书消息入口与调度源码分析

> 分析日期：2026-11-06。分析对象：`/Volumes/伊泽瑞尔/grain` 中飞书 IM 消息到 Niuma workflow 的链路。本文基于静态源码阅读，未发起真实飞书/GitHub 请求，也未运行测试。与 [Lark 工具总览](./14-grain-niuma-lark-tools-analysis.md) 的区别：本文只分析**消息接收、快速响应和任务派发**，不讨论 Agent 在云端如何执行文档/Base 操作。

## 1. 一张图看清边界

```text
飞书 im.message.receive_v1
  -> scheduler 单实例 WSClient / SDK EventDispatcher
       -> 进程内 message_id 短时去重 -> 立即返回让 SDK ACK
       -> event-router：bot 回环 / 群聊 @ / 特殊入口 /kill
       -> fast-responder：ToolLoopAgent
            第 0 步 react(emoji_type) -> SDK 给原消息加 reaction
            第 1 步 dispatch(target, model, effort, ...)
       -> niuma-dispatcher：线程锁定运行方、判定 pending 或新 run
            活跃 run -> Redis pending -> 云端 hook 轮询并注入
            空闲/明确切换 -> 预创建状态卡 + Redis 占位
                          -> GitHub workflow_dispatch(niuma.yml)
       -> workflow：接管状态卡，按 model 路由具体执行器
                     -> 运行中/收尾轮询 thread，最终回复与终态
```

**关键区别**：`react` 和 `dispatch` 是后端 fast-responder 暴露给小模型的两个 AI SDK 工具。`dispatch` 调用的是后端派发函数，不是直接给 Agent 一个 GitHub 凭据或飞书数据 API。状态卡片也不是第三个模型工具，而是在派发器内由程序发送。云端 Niuma 执行器使用的 `lark-cli`/MCP 是后续独立阶段。

## 2. 组件职责与源码位置

下表路径均相对于 Grain 仓库。

| 层 | 入口 | 作用 | 不负责什么 |
| --- | --- | --- | --- |
| 启动 | `packages/backend/src/scheduler.ts:664`、`feishu/ws-client.ts:86` | 仅生产环境启动单实例飞书长连接，配置应用 SDK 客户端 | 不做任务执行 |
| 事件接收 | `feishu/ws-client.ts:23`、`:120` | SDK 注册 `im.message.receive_v1`；5 分钟、最多 1024 项的进程内 message ID 去重；异步路由，快速 ACK | 不提供跨进程/重启后的持久幂等 |
| 路由准入 | `feishu/event-router.ts:69` | 排除 bot 回环；群聊通常必须 @ 本 bot，bot ID 缺失拒绝；识别 `/kill`；转 fast-responder | 不让普通讨论自动变成任务 |
| AI 分诊 | `feishu/responder/index.ts:37`、`:70`、`:119` | 按步限定工具，模型只看当前消息，选择运行方/档位 | 不读历史、不看图、不读取文档/Base、不回答实质问题 |
| 工具实现 | `feishu/responder/tools.ts:85` | 用 `ai` 的 `tool()` 与 Zod 定义两个工具，并将调用绑定到后端函数 | 不是云端通用 Lark 工具注册表 |
| 会话派发 | `feishu/niuma-dispatcher.ts:1284`、`:1460` | 解析显式模型指令，锁定 thread 的 runner；插话入队或启动新 workflow | 不让模型直接决定已有线程状态 |
| Redis 桥接 | `feishu/niuma-thread-bridge.ts:180`、`:617` | 原子判活跃、入 pending、轮询、收尾和 `/kill` 状态 | 不用进程内变量维护跨 run 状态 |
| 可见回执 | `feishu/niuma-status-card.ts:114`、`:152` | 派发前回复 thread 初始卡；失败刷终态 | 不决定是否授权或执行成功 |
| 外部启动 | `feishu/niuma-dispatcher.ts:2214`、`.github/workflows/niuma.yml:235` | POST GitHub `workflow_dispatch`，workflow 根据 thread 串行 | 204 只代表派发受理，不代表 Agent 工作完成 |

`ws-client.ts` 同时注册卡片回调和文档评论通知；那是**不同事件入口**，不经过本文所述的普通 IM fast-responder 全流程。`event-router.ts` 还对限定的告警、反馈、bad-case 群设置窄例外，其业务准入直接走专用派发，不应概括成「所有群消息必须 @」或「所有飞书事件先经小模型」。

## 3. 普通 IM 消息的逐步流程

### 3.1 接收与过滤

1. `startFeishuWsClient` 在 scheduler 启动，非生产环境或缺应用配置时不启动；SDK 建立长连接并注册 `im.message.receive_v1`。SDK 向 handler 给出事件本体，非 Webhook 外层 envelope（`feishu/types.ts:1`、`feishu/ws-client.ts:86`）。
2. handler 按 `message_id` 查询内存 Map：重复则跳过；否则启动 `routeMessageReceive(event)` 并立即 return，让 SDK 尽快 ACK。异步路由错误由 `.catch` 记录（`feishu/ws-client.ts:23-69`、`:120-143`）。这个 Map 只挡短时同进程重复，不能证明消息已持久入队或确保恰好一次派发。
3. 路由拒绝非用户发送者的普通消息，避免自身回复回环。群聊需要事件 `mentions` 含本 bot open ID；配置缺失也拒绝。P2P 不需要 @。白名单业务群例外走独立分支（`feishu/event-router.ts:69-185`）。
4. 精确文本 `/kill` 在群聊 @ 准入之后被处理，直接设置 thread 停止标记并回执，不调用 fast-responder，也不启动新 workflow（`feishu/event-router.ts:25`、`:187-221`）。

### 3.2 fast-responder 的两个工具

| 工具 | 输入/约束 | 执行 | 输出与副作用 |
| --- | --- | --- | --- |
| `react` | `emoji_type` 必须在 `VALID_REACTION_EMOJIS` 枚举 | `reactWithEmoji(message_id, emoji_type)` 调 SDK `messageReaction.create`；工具内同步置 `reacted` 标记 | 原消息表情；失败返回结构化 reason，不因此开放别的工具（`responder/tools.ts:110`、`feishu/reactions.ts:111`） |
| `dispatch` | `target` 为 `cursor`/`niuma`/`codex`，各运行方模型/effort 字段分开枚举；可选 `switch_runtime`、仅日志用的 `reason` | 先 `ensureReacted()`，再将字段收敛为 `RunnerSelection` 调 `dispatchRunnerForFeishu` | 可能返回已插入 pending 或已尝试启动 workflow 的结果；记录**实际** runner 决策（`responder/tools.ts:144-288`） |

`responderStepGate(0)` 只暴露并强制 `react`；其余步骤只暴露并强制 `dispatch`。强制 tool choice 时关闭不兼容的模型 thinking 配置。`ToolLoopAgent` 的 `stopWhen` 包含有效 `dispatch` 调用或最多 4 步。由此工具顺序是 SDK 层约束，不靠 prompt 自觉；同一步工具调用可能并发，因此每条消息的 `reacted`/`dispatched` 同步标志只让首次调用出站（`feishu/responder/index.ts:16-103`、`feishu/responder/tools.ts:92-129`、`:199`）。

模型仅收到本条事件的 chat type、message type 和 content；不拿历史、附件解析或资源数据。提示词描述分诊标准，后端还解析用户明确点名的运行方并限制 `target` schema；工具输入是**运行方建议**，最终需经 thread 锁裁决。若模型抛错或未完成 dispatch，`runFeishuResponder` 补默认 reaction 并派往默认运行方（`feishu/responder/index.ts:119-179`）。

### 3.3 已有 run 时：插话与切换

- thread key 取 `root_id || message_id`；同一话题的后续 @ 消息复用根消息 key。模型、档位与运行方通过 `resolveThreadRunner` 维持线程锁；用户明确点名或明确要求切换时经 `overrideThreadRunner` 更新。跨运行方切换还生成 `handoff_from_provider` 供 workflow 恢复上下文（`feishu/niuma-dispatcher.ts:1284-1375`、`:2455`）。
- 未切换且已有活跃 run，`enqueueIfThreadActive` 以单段 Redis Lua 同时判断 alive 并写 pending，直接返回 `enqueued:true`，**不新建 workflow、不新发状态卡**；云端 hook 经 `/api/internal/niuma/thread-poll` 拉取 pending（`feishu/niuma-thread-bridge.ts:180`、`:268`；`api/rest/internal.ts:1472`）。
- 真正切换运行方/模型/档位或要求压缩上下文，绕过旧 run 的 pending，启动新 run；否则「换模型」可能被旧 run 当作普通插话吞掉。workflow 针对同 thread 设置 `cancel-in-progress:false` 的串行组（`niuma-dispatcher.ts:1320-1400`、`.github/workflows/niuma.yml:235`）。
- hook 的普通轮询从 pending 取消息并续期；Stop 阶段 `finalize:true` 在同一 Lua 内判断是否还有消息：有则继续处理，无则移除 alive。`/kill` 通过 run token 区分旧 run 与后续新 run。workflow 装配的 PostToolUse、Stop、PreCompact hook 定义见 `.github/workflows/niuma.yml:674`；实际 `niuma-thread-hook.ts` 来自外部 `niuma-harness/actions/runtime-scripts@main`，**不在本次 Grain 源码中**，所以这里只确认后端协议与装配方式，不声称已审查 hook 实现。

### 3.4 空闲时：状态卡、占位、派发

1. `dispatchWorkflowForFeishu` 将消息元数据和原始 content 渲染为 task，生成稳定的会话 UUID 与本次 run token；需要的用户身份能力以短期 claim 表达，签发失败只取消相应能力，不提升权限（`niuma-dispatcher.ts:1460`、`:2500`）。
2. 后端先在原消息 thread 预创建一张「正在唤起云端」卡；取得 `status_card_id` 后传给 workflow。发卡失败为 fail-soft，workflow 会自行尝试发送卡（`niuma-dispatcher.ts:1520`、`niuma-status-card.ts:114`）。这是 `dispatch` 内部的程序动作，不是 fast-responder 的第三个工具。
3. 后端通过 Redis `markThreadDispatchedOrThrow` 在对外派发前写 alive/active 占位，覆盖 runner 冷启动期间的插话与 `/kill`。占位失败则**取消派发**、标记卡片失败、回复/告警（`niuma-dispatcher.ts:1544`、`niuma-thread-bridge.ts:332`）。
4. `postWorkflowDispatch` 将经过尺寸守卫的输入 POST 到 `niuma.yml` 的 workflow_dispatch。输入包括 task、thread key、run token、session UUID、身份 claim、状态卡 ID、模型/effort 等；`204` 判为受理。超长 task 裁中段、保头尾并提示云端按载体 ID 回源读取（`niuma-dispatcher.ts:2214`、`niuma-dispatch-payload.ts:85`）。
5. workflow 用同提交的基础脚本组装上下文，按 model 从外部 harness 注册表选择 runtime；有预创建卡时 adopt 并 PATCH 运行态，否则新发；收尾再刷终态（`.github/workflows/niuma.yml:609-628`、`:750-803`、`:1258-1310`）。后端与云端共同维护卡片生命周期，但发出 204 时并没有运行成功结论。

## 4. 失败与幂等边界

| 情况 | 源码处理 | 范围/限制 |
| --- | --- | --- |
| 飞书重复投递 | 进程内 5 分钟/1024 条 message ID 缓存 | 内存容量、重启与跨实例不覆盖；异步 ACK 先于实际派发 |
| 模型不调用工具或异常 | 补 reaction，调用默认派发 | 保证尽量有回执；不能把模型结果当授权或执行终态 |
| 同一轮模型多个工具调用 | `reacted`、`dispatched` 同步标记；工具按步骤隔离 | 只约束这次 responder 对象，不是外部系统的全局去重 |
| 插话与收尾竞争 | Redis Lua 原子判 alive/入 pending、原子 drain/删除 alive | bridge 不可用时入队 fail-soft 回退新 dispatch，可能额外启动 run |
| 预创建卡失败 | 不阻断派发，workflow 回退建卡 | 用户可见反馈可能延后；不能把卡片当执行授权 |
| Redis 派发前占位失败 | 停止外部 dispatch、将卡改失败并回执 | 不因无法维持取消/会话状态而继续启动 |
| GitHub 派发失败 | 网络与 5xx 退避；4xx（限流除外）判永久；最终失败清理对应占位、更新卡或发文本，永久错误升级告警 | 网络超时或 5xx 后重发属于非幂等外部副作用风险；仅从这些函数不能证明 GitHub 没接受前一次请求（`niuma-dispatcher.ts:2214-2356`） |

另外，`dispatch` 在调用派发函数前设置本轮 `dispatched` 标志；若底层调用**抛异常**，fast-responder 的外层 catch 会再走默认派发路径（`responder/tools.ts:199-286`、`responder/index.ts:147-179`）。这条路径与返回 `{ok:false}` 的正常失败结果不同；从当前代码看不能宣称它跨异常边界也保证恰好一次外部派发。报告将其列为需要进一步核验的风险，而非已经发生的重复派发事故。

## 5. 对 DeepAuto 的实现启示

1. 保留「入口快速 ACK、异步执行、原 thread 回执」分层，但先将事件与任务幂等持久化，再 ACK；不能复用 Grain 的进程内 Map 充当任务唯一性事实。
2. 若引入快速分诊模型，只暴露有限且无资源访问权的工具。`react`/状态卡是用户反馈，`dispatch` 必须再经过服务端成员、workspace、来源及 capability 校验；模型选中的 target 不能直接成为权限。
3. 将 `Conversation -> Job -> Attempt -> Execution` 作为会话和运行真相。插话、切换、取消、状态卡及回执需绑定已授权 workspace/conversation/execution/attempt，不能信任调用者自报的 thread、run token 或状态卡 ID。
4. 不直接迁移 Grain 的 GitHub workflow_dispatch/外部 harness、通用凭据或自动重发规则。外部启动发生不确定结果时先对账，避免把超时视为「一定没有启动」并重试。当前 DeepAuto `repository.change-pr.v1` 仍是 GitHub 来源 PR-only capability，飞书入口与 Lark 数据工具须分别设计准入。

## 6. 阅读范围与未确认项

- 已核对 Grain：`feishu/ws-client.ts`、`event-router.ts`、`responder/{index,tools,prompt.md}`、`niuma-dispatcher.ts`、`niuma-thread-bridge.ts`、`niuma-status-card.ts`、`reactions.ts`、`api/rest/internal.ts` 相关片段，以及 `.github/workflows/niuma.yml` 的关键装配步骤。
- 外部 `niuma-harness` 的 hook、路由注册表和执行器内部行为不在所查看的 Grain 源码中；未验证线上事件时序、GitHub 重试的实际去重效果或运行时成功率。
- 未读取或输出环境凭据、真实消息、用户资料与 webhook 原始载荷。测试与验证按当前项目要求暂停，**未运行**。
