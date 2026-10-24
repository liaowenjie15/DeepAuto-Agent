# B1：改造 Niuma 的可靠 Agent 执行闭环

## 实施状态

**已完成：FIFO、有限基础设施重试、执行器查询/取消契约、持久化取消意图、Worker 外部取消/状态对账与经授权的 GitHub 评论控制入口均已合并到 `main`。** PR #9 的 merge commit `d120496` 来自 `feat/reliable-agent-execution` 提交 `f195241`，在 Redis conversation claim 之后增加持久化队首检查，使较晚的 Job 即使先被 BullMQ 领取也不能越过同一 conversation 中更早的 `QUEUED` 或 `RUNNING` Job；新建的 BullMQ processor 会将 `deferred` Job 移回 delayed 状态并抛出 `DelayedError`，不再把它当作成功完成而丢失。新增集成用例验证三项连续 Job 中第一项失败后，第二、三项仍严格按创建顺序运行。

PR #10 的 merge commit `5c4fca8` 来自 `feat/execution-infrastructure-retries` 提交 `61ab3f5`，只对 GitHub API 的 `408`、`429` 与 `5xx` dispatch 失败进行有界重试；权限、认证、输入和未知错误仍直接终止。Worker 直调默认只尝试一次，BullMQ processor 默认最多三次基础设施尝试并在每次补发前延迟 5 秒；重试会将失败 Job 回置 `QUEUED`，并复用原队列 Job，不引入 payload、队列名、Redis key、数据库 schema 或 migration 变化。为保证源码和构建产物并存测试时的判断一致，重试使用专用错误守卫而非跨模块 `instanceof` 身份。

PR #11（`feat/executor-control`，提交 `918c6c0`、`f846662`）为 GitHub Actions Executor 提供正式的 `start`、`getStatus` 与 `cancel` 契约。受管 workflow 以 `execution_id` 写入 `run-name`；GitHub App 仅查询该精确名称的 `workflow_dispatch` Run，随后才可取消其解析出的 Run ID，避免由调用方传入任意外部 Run ID。取消请求获 GitHub 接受时返回 `cancelling`，只有后续查询观察到 workflow 终态 `cancelled` 才报告取消完成。该 PR 不新增 Gateway 路由、不改变取消授权顺序，也不修改数据库 schema、队列 payload/名称或 Redis key。

PR #12 已以 merge commit `5631e54` 合并到 `main`。该增量新增 `ExecutionCancellationRequest` 和 `EXECUTION_CANCEL` 控制 Outbox：排队 Job 仍可直接终态取消；已有运行中 Execution 的 Job 只原子写入取消意图和控制事件，保留 callback/conversation claim，直到 callback 或状态对账得到真实终态。普通执行队列不会消费控制事件；取消意图会阻止过期恢复把同一远端 Execution 重试为新 Attempt。PR #12 的 Hosted Runner `actionlint`、`workflow-boundary` 和完整 `validate` 均已通过。

PR #13 已于 2026-10-23 02:19（中国标准时间）以 merge commit `5052904` 合并到 `main`。该增量由 Worker 消费 `EXECUTION_CANCEL` 控制 Outbox，以受控 run-name 首次关联 GitHub Actions Run 并持久化其 Run ID/URL；后续取消和状态查询按该受控绑定执行，不接受调用方提供的外部 Run ID。GitHub 接受取消仅将请求记录为 `DISPATCHED`；Worker 以有限次数的状态对账确认真实终态，callback 与对账竞争时由第一个可验证终态原子获胜，超出窗口则记录审计异常。PR #13 的 Hosted Runner `actionlint`、`workflow-boundary` 和完整 `validate` 均已通过。

PR #14 已于 2026-10-24 16:28（中国标准时间）以 merge commit `12ab28a` 合并到 `main`。该增量在已签名、已映射成员且 repository allowlist 通过的 GitHub issue-comment 链路中增加 `@DeepAuto status`、`@DeepAuto cancel` 与仅限 OPERATOR/ADMIN 的显式 `@DeepAuto operator status|cancel`；控制范围固定为当前 workspace/conversation，普通成员仅能操作自己的活跃任务，裸 Job、Execution 或 Run ID 一律不接受。控制结果会审计并通过受控的评论回执发布器返回，不暴露内部标识。PR #14 的 Hosted Runner `actionlint`、`workflow-boundary` 和完整 `validate` 均已通过。

FIFO 增量本地已通过 Worker 单测、Worker/DB typecheck、Biome、Actionlint、`git diff --check` 和完整集成测试（27 项）；GitHub Hosted Runner 的 `actionlint` job 已通过（6 秒）、`workflow-boundary` job 已通过（5 秒）、完整 `validate` job 已通过（43 秒）。PR #10 本地已通过 `bun run build`、`bun run lint`、`bun run typecheck`、受影响单测、`git diff --check` 和完整集成测试（28 项）；Hosted Runner 的 `actionlint`、`workflow-boundary` 和完整 `validate` 均已通过。PR #11 已于 2026-10-22 16:47（中国标准时间）以 merge commit `612038a` 合并到 `main`；本地已通过同一组 build、lint、typecheck、`actionlint 1.7.12`、workflow-boundary、17 项针对性单测和完整集成测试（28 项），其 Hosted Runner 的 `actionlint`、`workflow-boundary` 与完整 `validate` 均已成功。PR #13 本地已通过 `bun run build`、`bun run lint`、`bun run typecheck`、完整单测、完整集成测试（33 项）、workflow-boundary 与 `git diff --check`；PR #14 本地已通过 `bun run build`、`bun run lint`、`bun run typecheck`、完整单测、完整集成测试（36 项）、workflow-boundary 与 `git diff --check`。本阶段的显式产品/安全决策为：首期不启用 session resume；任何恢复能力必须在后续独立任务中重新取得授权、定义同一 conversation/成员/workspace/权限快照约束、恢复窗口与审计规则。

## 目的

将 Grain/Niuma 已验证的会话续跑、状态可见、取消、失败补发和回执能力，改造成 DeepAuto 的控制面能力。

## 价值与意义

- 用户连续追问、Runner 暂时故障或任务取消时，系统仍能给出可信进度与明确出口。
- 把“一次 CLI 调用”升级为可审计、可恢复的异步 Execution。
- 为 GitHub Actions 与 Local Sandbox 共用同一状态机，避免各执行器各自发明会话和重试逻辑。

## 前置条件

- 完成 `Invocation → Job → Attempt → Execution` 状态机及幂等键设计。
- Redis 锁、取消信号、回调认证和数据库事务边界可测试。
- 已定义 conversationKey、workspace、调用者与权限快照的关联约束。

## 实现方案

1. Dispatcher 为每次执行生成 Attempt 和任务绑定凭证，而不是把用户上下文直接塞给 workflow。
2. ExecutorAdapter 提供启动、查询、取消和 callback 标准化接口。
3. GitHub Actions 只报告标准事件；Gateway 校验后更新状态并向飞书/GitHub 回执。
4. 同一 conversation 的多个任务使用 FIFO 队列：新任务不取消正在运行的任务，前项进入终态后才允许下一项领取执行资源。
5. 重试按失败类别决定：临时基础设施错误可限次补发，权限/输入/策略错误直接终止并解释。
6. session resume 仅在同一 conversation、调用者、工作区和权限范围一致时允许。

## 验收策略

- 重复 Invocation 不会产生两个可写执行。
- 同一 conversation 的三项连续任务严格按入队顺序运行；前项失败或取消后，下一项仍能按策略启动。
- 取消、超时、Runner 失联、回调重放、恢复执行均有确定状态转换测试。
- 回执在来源 thread/Issue/PR 上更新，但其内容来自控制面已验证状态。

## 人工决策

- 各失败类别的重试次数、退避时间与是否允许自动恢复。
- 是否允许同一 conversation 的后续消息自动恢复之前 session；排队不等于默认恢复 session，两项必须独立决定。

## 非目标

不接入 Grain 的 Niuma Harness、模型路由语法、缓存目录或飞书组织特例。
