# DeepAuto Agent：统一 Agent 平台架构

> 状态：架构决策草案  
> 更新日期：2026-10-18  
> 相关文档：[飞书机器人第一阶段搭建指南](./01-feishu-bot-setup.md) · [飞书权限 Scope 配置记录](./02-feishu-permission-scopes.md) · [开发工具链基线](./04-development-toolchain-baseline.md)

## 1. 已确定的产品边界

DeepAuto 是面向团队多用户的 Agent 平台，不是只会在飞书回复消息的机器人。

首期需要建立以下能力的共同基础，但不要求一次性把每项功能都交付完：

- 飞书文档、Base、日历与任务的读取和受控写入；
- 在飞书私聊或群聊 `@DeepAuto` 发起任务；
- 在 GitHub Issue / Pull Request 评论中 `@DeepAuto` 发起或继续代码任务；
- 克隆允许的仓库、创建分支、修改代码、运行验证、提交并创建 Pull Request；
- 模型以 GPT 为主、DeepSeek 为备用；
- 首期在本机 Docker 环境开发和验证；
- 代码托管首选 GitHub。Gitee 保留为未来的 Provider，不作为首期交付依赖。

首期明确不做：自动合并 Pull Request、自动部署生产、无确认的批量外部写入、让 Agent 直接操作宿主机。

## 2. 核心原则

### 双入口、单一任务模型

飞书和 GitHub 都只是任务入口。无论从哪里发起，系统先标准化为同一种 `Invocation`，再经过相同的权限、会话、队列、Agent 和审计链路。

```text
飞书 @DeepAuto ──────┐
                     │
GitHub 评论 @DeepAuto ├──→ Invocation → Dispatcher → Job → Agent Runner
                     │                                      │
其它入口（后续）──────┘                                      ├── Lark 工具
                                                            ├── GitHub 工具
                                                            └── 结果回执
```

这样避免“飞书 Agent”和“GitHub Agent”演化成两套不同权限、不同会话和不同交付规则的系统。

### 外部副作用默认保守

工具分为 `read`、`write` 和 `high-risk` 三类：

- `read`：按用户、工作区和资源授权执行，并写入审计；
- `write`：必须通过工具授权策略；首期默认要求任务中有明确写入意图；
- `high-risk`：创建 PR 之外的合并、部署、权限变更、批量删除等动作默认拒绝，须另行设计确认流程。

未知工具、未知资源归属和无法验证的调用者一律拒绝，不能通过模型“猜测”放行。

### 运行面与控制面分离

- **控制面**：身份、工作区、连接授权、任务、审批、审计、模型路由和仓库 allowlist；
- **运行面**：Gateway 收事件、Worker 执行任务、Runner 在隔离环境内改代码或调用工具。

飞书聊天不是控制面替代品。用户可以在飞书发起任务，但权限配置、任务回放、审批与故障处置需要独立的管理能力。

## 3. 总体架构

```text
                     ┌─────────────────────┐
飞书事件 ───────────→│ Lark Gateway        │
                     │ 单个长连接消费者     │
                     └─────────┬───────────┘
                               │
GitHub Webhook ──────→┌────────▼───────────┐
                     │ Ingress API         │
                     │ 验签、去重、标准化   │
                     └────────┬────────────┘
                              │
                   ┌──────────▼───────────┐
                   │ PostgreSQL            │
                   │ 任务、权限、审计、连接 │
                   └──────────┬───────────┘
                              │
                   ┌──────────▼───────────┐
                   │ Redis / Queue         │
                   │ 幂等、延迟、并发、任务 │
                   └──────────┬───────────┘
                              │
                   ┌──────────▼───────────┐
                   │ DeepAuto Worker       │
                   │ 模型、策略、工具编排   │
                   └───────┬───────┬──────┘
                           │       │
             ┌─────────────▼─┐   ┌─▼─────────────────┐
             │ Lark Provider │   │ Runner Manager     │
             │ Docs/Base/... │   │ 隔离 Worktree 容器  │
             └───────────────┘   └─────────┬─────────┘
                                             │
                                   ┌─────────▼─────────┐
                                   │ GitHub Provider    │
                                   │ Branch/Commit/PR   │
                                   └───────────────────┘
```

### 本机 Docker 服务边界

| 服务 | 职责 | 首期副本数 |
| --- | --- | --- |
| `postgres` | 用户、工作区、任务、审计、资源连接和授权元数据 | 1 |
| `redis` | 任务队列、分布式锁、短期幂等、限流与状态缓存 | 1 |
| `gateway` | 飞书长连接、GitHub Webhook 接收、快速 ACK | 1 |
| `worker` | 模型调用、工具规划、任务执行和结果回执 | 1，可横向扩展 |
| `runner-manager` | 受控创建和回收一次性代码 Runner | 1 |
| `admin-web` | 后续内部控制台；不是首期聊天 UI | 后续 |

`gateway` 必须保持单实例，避免同一飞书事件被多个长连接消费者处理。`worker` 可以并发，但必须依赖任务锁和幂等键。

代码 Runner 是短生命周期容器，不是长期服务。Worker 不应把 Docker Socket 直接暴露给模型或通用 Agent 进程；容器创建能力必须由受控的 `runner-manager` 持有。

## 4. 统一任务与会话模型

### Invocation

```text
Invocation
├── source: feishu | github
├── workspaceId
├── actorId
├── conversationKey
├── repositoryId? / resourceRefs[]
├── anchor: message | issue | pull-request | comment
├── instruction
├── sourceEventId
└── receivedAt
```

`conversationKey` 决定后续消息是否复用会话：

- 飞书：同一 thread 的 root message 或稳定 thread key；
- GitHub Pull Request：`repository + pull request number`；
- GitHub Issue：`repository + issue number`。

同一来源事件至少要做两层去重：Webhook / 消息投递 ID 去重，以及业务任务幂等键去重。Worker 发生超时或重试时，不得重复创建文档、任务、提交或 Pull Request。

### Dispatcher

Dispatcher 不直接执行任务，只负责：

1. 校验来源与调用者；
2. 解析资源、工作区、会话和任务上下文；
3. 锁定当前会话的模型路由；
4. 确定可见工具与写入策略；
5. 创建可审计的 Job 并入队；
6. 选择按飞书 thread 或 GitHub 评论回执。

## 5. 身份、工作区与授权

### 统一身份

团队多用户必须建立自己的成员模型，不能把一台开发机上的 `lark-cli` user token 当成产品身份系统。

```text
Workspace
└── Member
    ├── role: member | operator | admin
    ├── Lark identity: open_id
    ├── GitHub identity: GitHub user id / login
    └── provider connections
```

飞书用户与 GitHub 用户不是天然同一人。首次使用 GitHub 入口前，需要将 GitHub 身份与工作区成员关联；GitHub 评论触发写代码时，必须同时满足：

1. GitHub App 已安装到该仓库；
2. 仓库在工作区 allowlist 中；
3. 评论者是已关联成员，且满足规定的仓库权限；
4. 当前任务策略允许在该分支或该 Pull Request 上写入。

### Token Vault

- 飞书 bot token 用于应用级动作；
- 飞书 user OAuth token 仅代表对应用户访问其私有资源；
- GitHub App installation token 仅代表被安装到的仓库范围；
- 所有长效或可刷新的凭证均加密入库，不把 token 交给模型文本、日志或普通任务 payload；
- refresh token 的轮换必须串行化，避免并发刷新导致旧 token 被重复消费。

首期采用单一主密钥加密信封；部署到共享环境前再升级为 KMS / Secret Manager 管理的密钥层级。

## 6. GitHub 优先的代码平台设计

### 为什么首期选择 GitHub

GitHub 是首期唯一需要交付的代码平台。系统使用 GitHub App，而不是共享 Personal Access Token：安装范围、仓库 allowlist、Webhook 和短期 installation token 都可围绕 App 管理。

首期 GitHub App 只申请完成以下能力所需的最小仓库权限：

- 读取仓库元数据与代码；
- 通过 HTTPS Git 克隆、创建分支、推送提交；
- 创建和评论 Pull Request；
- 读取检查结果，用于回执测试状态；
- 接收 `issue_comment`、`pull_request`、`pull_request_review_comment` 和 `pull_request_review` Webhook。

最终注册 App 时，以 GitHub 后台当前显示的最小权限名为准；不申请仓库管理、Secrets、Actions 管理、组织成员管理、自动合并或部署权限。

### 代码任务规则

| 来源 | 默认行为 |
| --- | --- |
| 飞书代码任务 | 在 allowlist 仓库创建 `deepauto/<task-id>` 分支，修改、验证、提交、创建 PR，并回飞书 thread 链接与摘要 |
| GitHub Issue 评论 `@DeepAuto` | 读取 Issue 和仓库上下文，创建新分支与 PR，在 Issue 评论中回执 |
| GitHub PR 评论 `@DeepAuto` | 默认围绕当前 PR 处理；只在策略允许时向该 PR 分支追加提交，否则创建后续 PR 并说明原因 |

所有代码 Runner 必须：

- 在独立临时 Worktree / 容器中执行；
- 使用允许的仓库与受限网络；
- 记录基础镜像、代码基线 SHA、分支、提交 SHA、测试命令与输出摘要；
- 禁止直接推送默认分支；
- 禁止合并、发布、修改仓库设置；
- 在任务结束后销毁工作目录和临时凭证。

### Provider 抽象

首期只实现 `GitHubProvider`，但业务层不直接依赖 GitHub REST 形状：

```text
CodeHostProvider
├── resolveRepository()
├── verifyIncomingEvent()
├── cloneForTask()
├── createBranch()
├── pushCommits()
├── createPullRequest()
├── commentOnAnchor()
└── readPullRequestStatus()
```

未来接入 Gitee 时实现 `GiteeProvider`，不重写 Invocation、Job、Runner 或权限策略。

## 7. 飞书能力的接入方式

飞书能力按“连接身份 + 资源类型 + 读写级别”注册，不允许把全部 Lark skill 直接暴露给 Agent。

| 能力域 | 首期基础 | 写入策略 |
| --- | --- | --- |
| 文档 / 云盘 | 定位、读取、创建与受控编辑 | 明确任务意图后执行，记录文档 token 与变更摘要 |
| Base | 读取表、字段与记录；后续增加建表/改记录 | 单条或小批量写入优先；批量变更另设确认 |
| 日历 | 查询日程和忙闲 | 创建、修改、取消前要求明确目标与时间 |
| 任务 | 查询、创建、更新状态 | 明确负责人、截止时间与工作区归属 |

生产运行时代码使用飞书 SDK / OpenAPI；`lark-cli` 仅用于开发机配置、授权验证和诊断，不能成为服务端执行依赖。

## 8. 模型路由与执行安全

### 路由策略

```text
默认文本、代码规划、工具选择：GPT
明确可重试的模型供应商故障：DeepSeek 备用
```

模型调用需要记录：路由名、实际 provider / model、尝试序号、耗时、token、成本、失败分类和是否已发生外部副作用。

### 允许备用模型的条件

- GPT 请求尚未产生任何工具调用或外部副作用；
- 出现网络超时、限流或供应商不可用等明确可重试错误；
- DeepSeek 已通过该路由的工具调用与结构化输出评测。

以下情况禁止中途换模型并重跑整轮：工具调用结果未知、已创建外部资源、参数校验失败、权限错误、用户取消、模型返回了需要人工确认的高风险计划。

将任务拆成“模型规划”和“确定性工具执行”两段：前者可降级，后者依赖幂等键、审计与明确的执行结果。

## 9. 审计、确认与可观测性

每个 Job 至少写入：

```text
发起工作区与成员
来源事件与会话锚点
模型路由与调用摘要
工具名称、参数摘要、资源标识、读写级别
确认依据
执行状态、重试、错误分类
代码基线、分支、提交与 Pull Request 链接
飞书或 GitHub 回执位置
```

系统日志使用任务 ID、来源事件 ID、工作区 ID 和运行实例 ID 关联。用户可见的回执不泄露 token、内部异常堆栈或其他成员的资源信息。

首期可在飞书中完成写操作确认；在接入高风险代码动作前，需要建设最小内部控制台，用于仓库 allowlist、成员角色、连接状态、任务终止、失败重试和审计查询。完整 Web 聊天 UI 不属于前置条件。

## 10. 分阶段实施

### Phase 0：工程与本机运行基座

- TypeScript workspace、Docker Compose、配置加载与 Secret 规则；
- Postgres、Redis、Gateway、Worker、Runner Manager 健康检查；
- 数据库迁移、基础日志、任务 ID 与审计表；
- 不暴露任何飞书写入或代码写入工具。

**验收**：本机一条命令启动依赖与服务；Gateway 和 Worker 有独立健康状态；凭证不进 Git。

### Phase 1：统一入口与任务生命周期

- 飞书 `@DeepAuto` 进入统一 Invocation；
- GitHub App Webhook 进入同一 Invocation；
- 签名验证、事件去重、会话键、队列、取消和来源回执；
- 仅启用无副作用的模型回应与上下文读取。

**验收**：飞书和 GitHub 评论都能创建同一种 Job，并分别在原 thread / 评论得到任务状态。

### Phase 2：权限、审计与 Lark 基础能力

- 工作区成员、角色、Lark / GitHub 身份关联；
- 加密连接凭证、工具策略、写入确认与审计查询；
- 文档、Base、任务、日历按独立能力逐项接入。

**验收**：不同成员、不同工作区和不同资源无法越权；每次写入都能回溯到发起人和工具调用。

### Phase 3：代码 Runner 与 GitHub Pull Request 交付

- 受控 Worktree 容器、仓库 allowlist、短期 GitHub installation token；
- 飞书与 GitHub 评论两条代码任务入口；
- 分支、提交、PR 创建、测试摘要与双来源回执；
- 默认禁止自动合并与部署。

**验收**：测试仓库中，飞书任务和 GitHub PR 评论都能生成可审查的 PR，且无法写入默认分支。

### Phase 4：内部控制台与运营能力

- 仓库与成员管理、连接诊断、任务终止/重试、审计检索；
- 高风险确认卡与审批流；
- 模型路由、成本和可靠性看板。

## 11. 开始实现前仍需确认的事项

1. 首批 GitHub Organization、测试仓库和默认分支策略；
2. GitHub App 的所有者、公开范围和本机 Webhook 转发方案；
3. GPT 与 DeepSeek 的具体模型、API Key 来源、预算与速率限制；
4. 工作区成员初始角色，以及 GitHub / 飞书身份绑定流程；
5. 首期文档、Base、日历、任务中最先交付的一个具体读写场景；
6. 数据保留期限、日志脱敏和生产 Secret Manager 的选择。

在上述事项确认前，不应开始批量安装能力包或开放写入工具。
