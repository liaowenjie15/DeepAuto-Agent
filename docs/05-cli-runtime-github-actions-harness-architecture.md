# DeepAuto Agent：CLI Runtime 与 GitHub Actions Harness 架构决策

> 状态：准备阶段架构基线（尚未进入业务代码实现）  
> 创建日期：2026-10-19  
> 相关文档：[统一 Agent 平台架构](./03-unified-agent-architecture.md) · [飞书机器人第一阶段搭建指南](./01-feishu-bot-setup.md) · [开发工具链基线](./04-development-toolchain-baseline.md)

## 1. 本文结论

DeepAuto 可以借鉴 Grain 的 Niuma，以 **CLI runtime + GitHub Actions Harness** 执行代码任务；但不应把 GitHub Actions 变成所有 DeepAuto 任务的唯一执行平台。

首期采用 **控制面自持、执行面可插拔** 的混合架构：

```text
飞书 / GitHub 事件
  → DeepAuto Gateway
  → Dispatcher
  → PostgreSQL + Redis（任务、授权、审计、锁、队列）
  → ExecutorAdapter
      ├── GitHubActionsExecutor（代码修改、验证、Pull Request）
      └── LocalSandboxExecutor（飞书资源读取与短任务）
  → DeepAuto 接收终态、持久化审计、回执来源 thread / Issue / PR
```

这条路线保留 DeepAuto 已确定的 `Gateway + Worker + Runner Manager` 边界，同时吸收 Niuma 已验证的可靠性能力：快速反馈、同会话串行、会话续跑、状态可见、失败补发与执行隔离。

## 2. Niuma 的参考模型

Niuma 不是 LangChain、CrewAI 等单一 Agent 框架，而是由多个层次组成的执行体系：

1. **GitHub Actions 工作流**：接收 GitHub 事件和后端的 `workflow_dispatch`，准备仓库上下文、密钥、状态卡片和失败兜底。
2. **Niuma Harness**：按模型注册表选择 runtime，统一会话缓存和续跑、MCP 与 hook 配置翻译、事件流格式和交接摘要。
3. **CLI runtime**：按模型路由运行 Claude Code、OpenAI Codex CLI、Cursor CLI 或 DeepSeek Harness。
4. **Grain 后端派发器**：接收飞书事件，创建秒级反馈与状态卡片，计算 thread/session 标识，控制 Redis 并发槽位和补发队列，并启动对应 GitHub Actions run。
5. **回执与恢复链路**：执行过程持续更新状态；临时错误可补发；永久失败会升级给人工；同一 thread 的后续消息复用既有会话。

Niuma 最有价值的部分不是“使用了哪些模型”，而是把一次 Agent 执行当成可追踪、可取消、可恢复的异步任务。

## 3. DeepAuto 与 Niuma 的边界差异

DeepAuto 的目标是面向团队多用户的通用 Agent 平台，除代码任务外，还要处理飞书文档、Base、日历、任务等资源。它不能直接复制 Niuma 的执行位置。

| 维度 | Niuma | DeepAuto 首期决策 |
| --- | --- | --- |
| 主入口 | GitHub 事件、飞书召唤 | 飞书与 GitHub 统一为 Invocation |
| 控制面 | Grain 后端 + GitHub workflow | DeepAuto Gateway、Worker、PostgreSQL、Redis |
| 代码执行 | GitHub Actions 中的 CLI runtime | GitHub Actions Executor，可复用 CLI runtime |
| 飞书短任务 | 主要由后端和专用能力处理 | Local Sandbox / Worker 执行，不绕 Actions |
| 任务真相 | 后端与 workflow 协作 | PostgreSQL 是唯一业务真源 |
| 会话模型 | 飞书 thread 映射 runtime session | Conversation + Conversation Key，执行器不得自行定义 |

因此，GitHub Actions 是 DeepAuto 的 **可选执行器**，不是身份、授权、审计、任务状态或用户会话的真源。

## 4. 推荐的执行器模型

### 4.1 ExecutorAdapter

Dispatcher 只依赖统一的执行器接口，不直接调用 GitHub Actions、Docker 或某个 CLI：

```text
ExecutorAdapter
├── start(job, executionContext) -> executionRef
├── requestCancel(executionRef)
├── query(executionRef) -> executionStatus
└── ingestCallback(callback) -> normalizedExecutionEvent
```

`executionContext` 由控制面生成，至少包含：

- `jobId`、`attemptId`、来源 `Invocation`、`conversationKey`；
- 调用者、工作区、资源归属和当次权限快照；
- 工具白名单、写入策略、模型路由和成本/时限预算；
- 回执锚点（飞书 thread、Issue、Pull Request 或评论）；
- 短期、任务绑定的凭证领取 claim，而不是长期 token。

### 4.2 GitHubActionsExecutor

仅用于有明确代码仓库上下文的任务：

- 克隆 allowlist 内仓库；
- 创建任务分支；
- 运行指定 CLI runtime、测试和静态检查；
- 推送提交、创建或更新 Pull Request；
- 上传执行日志、测试摘要和结构化终态事件。

它不得负责：

- 决定用户是否有权访问仓库；
- 保存长期飞书 OAuth token、主密钥或数据库连接串；
- 直接修改任务最终状态；
- 合并 Pull Request、部署生产、修改仓库设置；
- 对飞书、日历、文档等非代码任务进行默认执行。

### 4.3 LocalSandboxExecutor

用于低延迟、非代码或只读任务，例如：

- 读取已授权的飞书文档、Base、日历和任务；
- 汇总、问答、规划和无需仓库 checkout 的工具调用；
- 明确受限的小型写入操作。

这避免了每次飞书查询都启动 GitHub Actions，也避免把用户私有资源凭证扩散到 CI 环境。

## 5. CLI Harness 的职责

Harness 是执行器内部组件，不是业务控制面。无论未来接入 Codex、Claude Code、Cursor 还是其它 CLI，Harness 都必须统一以下能力：

1. **模型注册表**：模型名到 runtime、认证方式、最大时长、默认能力集的映射；未知模型拒绝执行。
2. **工作区准备**：仓库基线 SHA、任务 worktree、临时 Git 凭证、允许的环境变量和只读/读写挂载。
3. **能力装配**：MCP、CLI 配置、技能文件、工具白名单和网络规则；禁止按自然语言临时扩大能力。
4. **会话处理**：根据 `conversationKey` 恢复或创建 runtime session；跨 runtime 切换只传递经过裁剪的业务摘要，不能假设工具调用 ID 可兼容。
5. **事件归一**：把 runtime 原始流转换为标准事件，如 `started`、`progress`、`tool_started`、`tool_finished`、`artifact`、`completed`、`failed`。
6. **产物回收**：收集 diff、提交 SHA、测试命令和结果摘要，销毁临时目录、临时 token 和容器。

首期只接入 **一个** CLI runtime。多 runtime 是后续兼容能力，不是 MVP 前置条件。

## 6. 控制面必须保留的责任

### 6.1 统一任务状态机

PostgreSQL 必须持久化以下层次：

```text
Invocation
  → Job
    → Attempt
      → Execution
        → ToolExecution / Artifact / Delivery
```

首期状态至少包含：

```text
received → queued → running → waiting_confirmation
                         ├→ succeeded
                         ├→ failed
                         └→ canceled
```

状态转换只能由 DeepAuto 控制面确认。GitHub Actions 的 run 结果是证据来源之一，不是唯一真相。

### 6.2 幂等、并发与取消

- 每个来源事件同时有“投递 ID 去重”和“业务任务幂等键”两层保护；
- 同一 `conversationKey` 默认串行，避免 thread 内多个任务互相覆盖上下文和写入结果；
- 所有外部写入必须有可重复调用的幂等标识；
- 取消请求绑定到具体 `attemptId` 与 `executionRef`，不能误杀同一 thread 的后续任务；
- 已经发生推送、创建文档、创建任务或 Pull Request 时，禁止自动重跑整轮 Agent，只能根据已记录的副作用继续恢复或交给人工处理。

### 6.3 凭证与身份

控制面需要持有并加密保存长期凭证；执行器只能领取一次性、短期、任务绑定的最小权限凭证。

```text
DeepAuto 控制面签发 claim
  → GitHub Actions / Sandbox 回调 DeepAuto
  → DeepAuto 校验 job、attempt、调用者、资源和有效期
  → 返回最小权限短期凭证
```

不允许把以下内容放入 GitHub Actions secrets、workflow input、普通日志或模型 prompt：

- 飞书用户 access token / refresh token；
- 数据库连接串、主加密密钥；
- 不属于当前任务的 GitHub installation token；
- 未经脱敏的执行日志、用户私有资源正文。

## 7. 模型策略决策

当前 DeepAuto 文档定义“GPT 为主、DeepSeek 为备用”。采用 CLI Harness 前，必须明确下面两种路线中的一种：

### 路线 A：保留当前模型策略（推荐）

- 普通飞书任务由 AI SDK 调用 GPT，满足严格条件时切换 DeepSeek；
- 代码任务首期选择一个与该策略兼容的 runtime；
- CLI runtime 只承担代码执行和受控工具编排；
- 模型切换只发生在尚未执行任何外部工具、且失败可证明可重试时。

### 路线 B：全面采用 Niuma 式多 CLI runtime

- Codex、Claude Code、Cursor 等均成为可选执行内核；
- 需要额外建设模型注册、账号池、会话交接、成本归集、权限一致性和跨 runtime 评测；
- 成本和复杂度显著增加，不适合作为 DeepAuto MVP 的前置条件。

无论选择哪条路线，工具调用结果未知、已经创建外部资源、权限错误、用户取消和需要人工确认的计划，都禁止自动切换模型或从头重跑。

## 8. 进入代码前必须关闭的决策

以下问题未形成明确结论前，不开始 Gateway、Worker、GitHub App 或 Runner 的业务实现：

1. V1 的目标用户、允许的 3–5 类任务和明确不支持的任务是什么？
2. 首期唯一 CLI runtime 是什么？它对应哪个模型路由和认证方式？
3. 哪些任务进入 GitHub Actions，哪些必须由 Local Sandbox 执行？
4. `Conversation Key` 的精确生成规则、串行规则、追问规则和会话过期规则是什么？
5. Job、Attempt、Execution 的字段、状态转换、超时、重试和取消条件是什么？
6. 各 Lark/GitHub 工具的 `read`、`write`、`high-risk` 分级、确认语义和审计字段是什么？
7. 短期 claim 的签发者、受众、有效期、一次性使用规则和撤销方式是什么？
8. Runner 的镜像、网络、文件系统、资源上限、Git 凭证、日志脱敏和清理责任如何定义？
9. 每类失败如何通知用户、何时自动恢复、何时升级给人工？
10. V1 的验收矩阵是否覆盖私聊、群 @、重复投递、并发追问、权限拒绝、模型超时、执行器崩溃、已产生副作用后的恢复和取消？

## 9. 建议的准备阶段交付物

在 Phase 0 的代码骨架前，依次完成以下文档并经架构评审确认：

1. **产品范围与任务目录**：用户、任务类型、非目标、成功定义和人工介入边界。
2. **任务与会话状态机**：数据模型、幂等键、状态转换、重试、取消与回执协议。
3. **身份、授权与工具策略矩阵**：成员、工作区、资源、连接、工具与确认策略。
4. **Executor 与 Harness 契约**：接口、标准事件、Action callback、会话恢复和产物格式。
5. **Runner 隔离与凭证流规范**：网络、镜像、资源、临时凭证、清理和日志脱敏。
6. **模型路由与评测规范**：首期 runtime、可降级边界、成本预算、质量基线和失败分类。
7. **可观测性与验收矩阵**：结构化日志、审计、指标、告警、故障演练和端到端测试场景。

## 10. 实施顺序

当第 8 节决策全部关闭后，按以下顺序开始实现：

1. `contracts` 与数据库 schema：实现任务、审计、会话、授权和幂等数据模型；
2. Gateway：实现飞书单长连接、来源校验、秒级反馈和 Invocation 创建；
3. Worker：实现队列、会话锁、状态机、标准回执和失败处理；
4. Local Sandbox 的只读任务：先验证授权、审计和回执链路；
5. GitHub App 与 GitHubActionsExecutor：只实现 allowlist 仓库的代码任务；
6. 首个 CLI Harness：只接入一个 runtime，并以隔离 worktree、测试、分支和 Pull Request 交付验收；
7. 再评估多 runtime、内部控制台和高风险写入能力。

## 11. 验收门槛

在开始任何真实代码修改任务前，系统必须能证明：

- 重复飞书或 GitHub 事件不会创建重复 Job；
- 同一会话的执行不会并发写入；
- 用户能在原始 thread 或评论中看到已接收、执行中和终态；
- 执行器崩溃或 GitHub Actions 不可用时，任务不会静默丢失；
- 未授权调用者、未知仓库、未知工具和未知资源归属均被拒绝；
- 长期凭证不会出现在模型上下文、日志、workflow input 或产物中；
- 代码任务只能修改允许仓库的非默认分支，且以测试、提交和 Pull Request 为唯一交付形式；
- 已产生外部副作用的失败任务能够展示已知事实，而不是从头再执行一次。

满足以上门槛后，DeepAuto 才具备以 Niuma 的可靠性模式扩展代码 Agent 的基础，同时仍保持自身的多入口、多用户和多资源平台架构。
