# Grain `feishu/` 目录与 DeepAuto 接入边界评估

> 分析日期：2026-11-06。源码基线：`/Volumes/伊泽瑞尔/grain/packages/backend/src/feishu/` 与当前 DeepAuto 工作树。仅静态阅读，未调用飞书/GitHub，也未执行测试或验证。文中的 Grain 路径均相对其仓库根目录。本文是实现评估，不授权复制 Grain 的业务代码或启用外部副作用。

## 结论

**如果目标只是「飞书私聊、群聊 @DeepAuto -> 接收任务 -> 及时反馈 -> 原话题回执」，该目录包含 Grain 端大部分可参考的飞书侧逻辑，但不是 DeepAuto 实现的大部分代码。** 可借鉴的是 SDK 长连接、消息准入、表情/话题回复和状态卡的调用方法。Grain 的派发、会话桥接、模型分诊、OAuth 与人员映射在同一目录里，但分别绑定 Grain 的 GitHub Actions、Redis 协议、业务群、运行时与单租户假设；它们应重新接入 DeepAuto 的 Gateway、Workspace、Job、Attempt、Execution 和能力策略。

如果目标扩大为「Agent 读写文档、Base、日历和任务」，答案是**否**：这些工具主要在 runner 侧 `lark-cli` + Skills 或另一路 Connector 中，`feishu/` 目录主要负责事件入口和调度，**不是完整的飞书数据工具实现**。参见 [工具总览](./14-grain-niuma-lark-tools-analysis.md) 与 [入站链路](./15-grain-niuma-feishu-message-dispatch-report.md)。

## 1. 目录边界

```text
Grain scheduler (单实例)
  -> feishu/ws-client.ts (SDK 长连接、短时去重、异步 ACK)
  -> feishu/event-router.ts (bot/@/业务群例外、/kill)
  -> feishu/responder/* (仅 react + dispatch 的快速分诊)
  -> feishu/niuma-dispatcher.ts
       -> niuma-thread-bridge.ts (Redis thread 状态)
       -> niuma-status-card.ts + reply.ts + reactions.ts (飞书出站)
       -> niuma.yml workflow_dispatch (外部 GitHub Actions)

另有：doc-comment-summon、Base 按钮入口、用户 OAuth、PR 合并卡、
       运营告警、受限调度队列（不属于聊天最小闭环）。
```

**不在目录内的依赖**：`packages/backend/src/scheduler.ts` 的启动、`api/rest/internal.ts` 的 runner 轮询与 token 领取、`api/feishu-oauth.ts` 的授权路由、`services/niuma-dispatch-drainer.ts` 的排队恢复、`.github/workflows/niuma.yml` 与外部 `niuma-harness` 的执行/Hook、`.github/scripts/lark-send.ts`、`.agents/skills/lark-*`，以及产品 Connector `packages/backend/src/connector/feishu/adapter.ts`。因此不能仅复制此目录就获得 Agent 工具、任务执行或完整回执链路。

## 2. 模块逐项处理建议

| Grain 文件 | 本来做什么 | Grain 强绑定 / DeepAuto 处理 |
| --- | --- | --- |
| `types.ts` | 飞书事件的 TS 形状 | **参考并重写边界解析**：与 SDK 事件形状相关；实际入站需校验字段与消息类型，不能只作类型断言。 |
| `lark-client.ts` | bot 身份 SDK 客户端和飞书错误诊断 | **提取适配思路**：SDK 缓存、脱敏错误有价值；域名固定 `Lark.Domain.Feishu`，应由受信配置决定并隔离国内飞书/国际 Lark；不照搬含目标 ID 的诊断日志。 |
| `ws-client.ts` | 生产单实例 WS、事件注册、内存去重、异步 ACK | **重做 Gateway 适配器**：将事件持久化并判重后再确认接收；Grain 的 5 分钟/1024 项 Map 不足以承诺跨重启幂等；不复制其评论和合并回调注册。 |
| `event-router.ts` | sender/@ 过滤、例外入口、`/kill` | **保留最小准入思想**：仅私聊与群 @；删掉 Grain 告警群、bad-case 群、反馈群免 @ 规则；`/kill` 改接 DeepAuto 已授权的 execution cancel，而不是按裸 thread key 改 Redis。 |
| `reactions.ts` | emoji 枚举与 `messageReaction.create` | **可参考出站包装**：首期用固定或有限 emoji；错误输出按最小必要脱敏。它只是反馈，不代表 Job 成功。 |
| `reply.ts` | thread reply、主动私聊/群发 | **重做受控回执 Provider**：基于持久化 Invocation 的受信 chat/message anchor 寻址；默认 `reply_in_thread` 值得保留；不能允许 Agent 自填接收人或任意 message ID。 |
| `niuma-status-card.ts` | 预创建、失败更新交互卡 | **参考生命周期**：状态归属应落 DeepAuto Job/Attempt/Execution；卡片 ID 要与 workspace、conversation、attempt 绑定，失败应有终态；先做文字反馈也可。 |
| `responder/index.ts`、`responder/tools.ts`、`prompt.md`、`prompt.zh.md` | AI 只用 `react`/`dispatch` 两工具选 Niuma/Codex/Cursor 等运行时 | **暂不复制**：模型与 prompt 为 Grain 成本/运行时策略；DeepAuto 第一阶段可固定反馈后由服务端选择已注册 capability。若以后引入分诊，只接受模型的非授权建议，并经服务端策略校验。 |
| `niuma-dispatcher.ts` | IM、告警、反馈、Base、评论召唤，thread/runner 锁、任务文本、状态卡、GitHub workflow_dispatch | **拆解重写**：不能迁移其 2,787 行合体实现、固定仓库/ref、运行时模型路由、业务群或原始事件拼 prompt。替换为 `normalize -> authorize -> capability -> Job/outbox -> Worker`。 |
| `niuma-dispatch-payload.ts` | 控制 GitHub workflow_dispatch 输入尺寸 | **仅作为外部派发参考**：不应成为飞书消息被截断的全局契约；DeepAuto 先持久化原始任务引用/受控摘要，具体执行器单独定义载荷上限。 |
| `niuma-thread-bridge.ts` | Redis alive/pending/runner/kill、Lua 原子操作、跨 run 插话 | **重构到自己的会话模型**：状态以 workspace/conversation/attempt 为权威，避免任意 threadKey 混用或 hook 直接决定取消；首期可以先串行执行，不做运行中插话/跨运行时交接。 |
| `niuma-dispatch-limiter.ts`、`niuma-guarded-dispatch.ts` | Grain 运营来源的 Redis 槽位、持久排队、失败补发 | **暂不引入**：面向 Grain 的 90 分钟 workflow 和反馈洪峰；DeepAuto 已有 Job/outbox/Worker，限流应基于其任务与 capability 策略。 |
| `niuma-dispatch-failure-alert.ts` | 派发失败告警、固定负责人/群、冷却 | **替换**：保留「召唤者可见终态 + 运维告警」原则，不复制固定人员 ID、群 ID、Grain 的告警频道与携带任务片段的日志。 |
| `team-directory.ts` | 姓名与 open ID 的团队静态映射 | **不复制**：包含 Grain 人员数据；用 DeepAuto `WorkspaceMember.larkOpenId` 与受控租户映射；名字只作展示，不能代替身份校验。 |
| `user-oauth.ts` | 用户 OpenAPI OAuth、refresh token 加密存库、同用户串行刷新、runner 领取 claim | **后续单独设计**：MVP 聊天仅需 bot 身份；用户私有读取才需要 OAuth。不能沿用仅以 open ID 为主键、把短时 user token 发给 Agent runner 的跨信任边界。 |
| `doc-comment-summon.ts` | 文档评论中 @bot 的独立召唤入口、应用事件发布自检 | **后续能力**：需要评论事件/权限与资源归属校验；不经过 IM fast-responder，也不能凭文件 token 或提及本身授权访问。 |
| `pr-merge-card-action.ts` | 飞书卡片按钮触发 GitHub PR 合并/删分支 | **明确排除**：DeepAuto 当前 PR-only 交付边界禁止自动合并、默认分支写入和部署；不可搬入 Gateway。 |

以上 21 个文件按功能覆盖了该目录全部模块；「可参考」不等于可原样复制。特别是 Grain 一些入口允许无 @ 自动触发、部分 Redis 故障选择 fail-soft、多处把事件文本/业务 ID 拼入日志或 task，这些取舍不应默认成为 DeepAuto 的权限与审计规则。

## 3. 关键强绑定证据

1. **项目与执行器**：`niuma-dispatcher.ts:573-585` 默认仓库指向 Grain、workflow 固定 `niuma.yml`，`:1284` 处理 Niuma/Codex/Cursor/DSH 的 thread 运行方锁，`:2214` 调 GitHub API。DeepAuto 的执行入口和 capability 不能以字符串替换仓库名后直接复用。
2. **业务路由**：`event-router.ts:80-180` 的告警、bad-case、反馈群允许非用户发送者或免 @ 自动启动，`niuma-dispatcher.ts:138`、`:747`、`:905` 还有群名单/业务链接规则。这些不是通用飞书事件处理。
3. **团队数据**：`team-directory.ts:21` 硬编码 Grain 员工姓名与 open ID；`niuma-dispatcher.ts:2500` 又将映射结果和原始飞书 content 注入云端任务。DeepAuto 必须从可信入口确定 workspace/actor，再以绑定后的成员 ID 授权，不把显示名或 prompt 当授权。
4. **多入口混写**：同一个 `niuma-dispatcher.ts` 还包含 Base 自动化按钮（`:1683`）、文档评论（`:1897`）、生产告警和反馈调查；不能因为它位于 `feishu/` 就认为全部属于聊天 MVP。
5. **凭据与权限**：`user-oauth.ts:47` 默认请求一组 Grain 需要的用户只读 scope；`:140` 的 claim 服务于其 GitHub Actions token 领取；`api/rest/internal.ts:1699` 的通用内部 token + claim 组合也不是 DeepAuto 已有的凭据链。用户授权须按 DeepAuto workspace/member/connection 重新定义。
6. **高危外部动作**：`pr-merge-card-action.ts:288` 的回调可进入 GitHub 合并流程，与 DeepAuto 的 PR-only 规则直接冲突。即便只是注册其卡片回调，后续误触发风险也不应引入。

## 4. DeepAuto 实际承接位置

| 现有代码 | 已具备 | 尚缺/注意 |
| --- | --- | --- |
| `packages/lark/src/index.ts` | 将受控形状的文本消息转 `InboundInvocation`，过滤 bot/群聊未 @，生成 conversation/idempotency key | 没有 SDK `im.message.receive_v1` 长连接、事件字段解析、出站反应/回复；`workspaceId`、`botOpenId` 当前由调用方提供，真实入口必须从可信服务端配置获取。 |
| `packages/db/src/authorization.ts`、`prisma/schema.prisma` | WorkspaceMember 的 `larkOpenId` 绑定、Invocation 来源事件唯一约束、Job/Attempt 记录 | 需要确定租户/应用与 workspace 的权威映射；多 workspace 同一 open ID 不能只凭发送者解析归属；回复锚点目前不是结构化字段。 |
| `apps/gateway/src/gateway-bootstrap.ts`、`app.ts` | GitHub webhook 与执行回调等控制面入口 | 无飞书长连接启动与消息入库/回执服务，现有配置模式也未接入飞书 app/bot 身份。 |
| `packages/contracts/src/capability-registry.ts`、`apps/gateway/src/dispatcher.ts` | 静态执行策略与来源准入 | 唯一 capability `repository.change-pr.v1` 仅 `github` 来源且要求 repository ID；当前 Feishu Invocation 不可直接启动任务。不得通过放宽 `allowedSources` 伪装成飞书工具能力。 |

**建议最小路径**：先做「消息接收 -> 服务端 workspace/member 绑定 -> 持久幂等与 Job/outbox -> 固定已允许的回复/反馈」，然后为飞书任务单独登记 capability 和 Worker 处理逻辑；文档/Base/OAuth 在消息闭环有真实审计与归属之后逐项增加。对第一阶段无需引入模型分诊、Redis running/pending 注入、Base 自动化或卡片合并。

## 5. 安全与实现顺序

1. **可信入口**：Gateway 长连接使用独立的 DeepAuto 应用，固定部署角色并阻止测试实例抢消费；验证消息关键字段和 sender 类型，群聊缺 bot ID 时拒绝，只有明确 @ 才生成任务。来源应用/租户、workspace 绑定由服务器确定，而非由事件文本或客户端参数决定。
2. **先持久、后确认**：将来源事件与唯一键、授权决策、回执锚点在事务中记录并入队。Grain `ws-client.ts:23` 的内存去重与先 ACK 后 fire-and-forget 不能保障故障时任务不丢；准确 ACK 能力仍受 SDK 长连接协议约束，应验证 SDK 的重试/ACK 行为并设计回执恢复。
3. **受限反馈**：reaction、状态消息和最终 reply 由已授权 Job 的服务端代码执行，接收目标从平台事件与持久锚点读取；外部回复可重复发送的情形需独立幂等。卡片在 Job/Attempt 成为终态时同步更新，失败不能长期显示处理中。
4. **能力与执行隔离**：飞书聊天任务和 GitHub PR 执行分开登记；Lark 文档/Base 工具经受控 Provider 按 workspace、member、resource、身份、scope 校验。代码 Runner 不持有飞书应用密钥或用户 token。任何不确定的身份/资源归属拒绝，外部副作用不盲目重试。
5. **分期扩展**：先 IM 文本与原 thread 回执；再按实际需求加评论召唤、用户 OAuth 私有读取、文档/Base 写入。每一项新增平台事件与 scope 都需要单独审批和审计，不迁移 Grain 的默认只读 scope 超集或业务自动触发例外。

## 6. 需要人工完成/确认的事项

第一阶段只有飞书应用后台和测试人员的配置需要人工参与；**不要把密钥、token、原始事件或真实成员数据发到聊天中**：

- DeepAuto 专用企业自建应用：启用机器人、选择**长连接**接收事件、订阅 `im.message.receive_v1`，创建并发布测试版本，限制可用范围。应用与 Grain 的应用身份必须分离。
- bot 应用身份权限：按飞书控制台实际权限名确认私聊接收、群 @ 接收、机器人发/回消息、表情回复。`docs/02-feishu-permission-scopes.md` 有计划清单，但源码不能证明后台当前生效版本和授权范围。
- 用受信方式取得并在部署 Secret 配置 App ID/App Secret，确认 bot open ID；现有 `.env.example` 使用 `LARK_BOT_OPEN_ID`，历史文档举例用 `FEISHU_BOT_OPEN_ID`，实现时先统一变量名，**不**沿用 Grain 的 `FEISHU_NIUMA_BOT_OPEN_ID`。
- 确定测试 workspace、成员与 `larkOpenId` 的绑定，邀请 bot 进入测试群，确认多 workspace/多租户时群会话如何唯一映射。只需提供**配置是否已完成**，不需要发送凭据或完整个人标识。
- 文档评论召唤、用户 OAuth 回调及 Base 按钮**不属于第一阶段**；只有确定纳入范围时，才分别配置评论事件与权限、OAuth 回调域名和逐用户授权、Base 自动化调用方式。

需要先由你确认的产品边界是：**首期是否只做「私聊 + 群聊明确 @ 的文本消息」闭环，而不加入文档评论、Base 按钮与用户 OAuth？** 这会决定后台应发布的事件与最小 scope。确认范围后，才值得逐项核对后台的人工配置状态。

## 静态分析范围

本报告基于 Grain `feishu/` 目录的文件清单、关键函数/依赖，以及 DeepAuto 当前 Lark normalizer、Gateway、数据库授权、capability registry 与本仓库飞书架构文档。未审查外部 `niuma-harness` 的实现；未读取任何实际凭据或环境文件。测试与验证按当前项目要求暂停，**未运行**。
