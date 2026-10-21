# DeepAuto Agent：Grain GitHub 自动化复用决策

> 目的：从 Grain 的 `.github/` 自动化体系中挑出对 DeepAuto 真正有用的能力，明确哪些现在复用、哪些必须改造、哪些等项目成熟后再考虑，以及哪些不应引入。本文是决策文档，不是把 Grain 的 workflow 逐文件迁移到 DeepAuto 的实施清单。
>
> 参照：`/Volumes/伊泽瑞尔/grain/.github/`、[统一 Agent 平台架构](./03-unified-agent-architecture.md)、[CLI Runtime 与 GitHub Actions Harness 架构决策](./05-cli-runtime-github-actions-harness-architecture.md)、[Grain 验证机制参考基线](./06-grain-code-validation-mechanisms.md)、[测试与验证实施方案](./07-testing-validation-implementation-plan.md)、[Codex 项目配置计划](./08-codex-project-configuration-plan.md)。

## 1. 结论先行

Grain 的价值不在于它有 64 条 workflow，而在于它把高副作用的 Agent 执行拆成了可控的边界：**明确触发源、最小权限、任务级并发、可观察状态、失败出口、以及把业务真相留在后端而非留在 GitHub Actions。**

DeepAuto 应复用这套方法，但不能复制其运营系统。DeepAuto 当前只有一个由控制面派发的 `deepauto-execute.yml`，并且已经决定由 Gateway、Worker、PostgreSQL、Redis 维护身份、授权、状态机和审计。因此：

1. **现在只引入验证与 workflow 安全基线。** 它们能立刻降低错误配置和越权执行风险，且不改变产品边界。
2. **把 Niuma 的可靠性能力改造成 DeepAuto 控制面的能力。** 会话续跑、状态卡片、取消、重试和回执应由 DeepAuto 的 `Invocation → Job → Attempt → Execution` 模型承接，不能让一个 GitHub workflow 自己成为真源。
3. **明确拒绝 Grain 的运营业务 workflow。** 内容巡检、SEO、视频、外联、支付日报、飞书表格回填等均依赖 Grain 数据域，对 DeepAuto 没有通用价值。
4. **不复制 Grain 的供应链做法。** Grain 的 Action 引用均为可变 tag 或 `@main`；DeepAuto 应反过来固定第三方 Action 到经过审查的 commit SHA，或至少建立更新审查机制。

## 2. 分级总览

| 分级 | 含义 | 数量级 | DeepAuto 决策 |
| --- | --- | --- | --- |
| A：现在复用 | 可作为小而独立的基线直接落地，不要求新增产品能力 | 4 项 | 进入当前工程/CI 工作 |
| B：改造后复用 | Grain 的问题定义正确，但代码、状态模型或权限边界必须换成 DeepAuto 的 | 7 项 | 按控制面与代码任务 Phase 实施 |
| C：后期考虑 | 只有在规模、真实数据或对应产品能力出现后才有收益 | 6 项 | 设立明确触发条件，暂不开发 |
| D：不复用 | Grain 业务专属、会扩大攻击面，或与 DeepAuto 已定架构冲突 | 8 类 | 不迁移、不预埋 |

## 3. A 类：现在复用

### A1. GitHub Actions 静态检查：`actionlint`

**Grain 参考**：`.github/actionlint.yaml` 与其 CI workflow。  
**DeepAuto 落点**：新增一个只读的 workflow 校验步骤；先覆盖 `.github/workflows/**`，不与执行任务绑定。  
**复用方式**：规则文件与 `actionlint` 检查模式可直接作为起点，但忽略项必须按 DeepAuto 实际表达式重新确认，不能盲目照搬。  
**目的**：在 PR 阶段发现 GitHub Actions 的 YAML、表达式、`needs`、`permissions` 与 shell 结构错误，而不是等到真正派发 Agent 才发现 workflow 无法启动。  
**价值**：这是最低成本的 CI 护栏；对 DeepAuto 尤其重要，因为一个 workflow 配置错误会把控制面发出的 Execution 卡在外部执行器边界。  
**验收**：对错误的 `if:` 表达式、无效 job 引用和格式错误的 workflow 能在 PR 中失败；正常的 `deepauto-execute.yml` 通过。

### A2. Workflow 安全基线模板

**Grain 参考**：其部署、Preview、审查 workflow 普遍使用 `timeout-minutes`、`concurrency`、显式 `permissions` 和受控 checkout。  
**DeepAuto 落点**：`/.github/workflows/deepauto-execute.yml` 及后续所有 workflow。  
**复用内容**：

- 每个 job 都设置符合任务预算的 `timeout-minutes`；
- 为同一个 Execution、Job 或 conversation key 设置可解释的 `concurrency.group`；
- 默认只读权限，需要写 GitHub 时才在具体 job 申请 `contents` 或 `pull-requests: write`；
- `actions/checkout` 保持 `persist-credentials: false`，不让默认 `GITHUB_TOKEN` 滞留在 Git 配置中；
- 明确记录取消语义：新任务是否取消旧任务、取消后控制面如何收到终态。

**目的**：防止重试、重复 webhook、用户连续追问或 Actions 重跑造成多个 Agent 同时修改同一工作区。  
**价值**：直接保护 DeepAuto 的“同一任务只有一个活跃执行”的不变量，也减少 Runner 成本与难以复现的竞态。  
**边界**：并发锁的权威状态仍在 Redis/PostgreSQL；GitHub 的 `concurrency` 只是执行面第二道保险，不可替代控制面锁。

### A3. 供应链固定与依赖审查策略

**Grain 反向参考**：Grain 的 Action 引用使用版本 tag 或内部仓库 `@main`，没有使用 40 位 commit SHA。  
**DeepAuto 落点**：所有新增或修改的 `uses:`；当前 `actions/checkout@v4` 也应纳入统一策略。  
**复用方式**：复用“集中盘点 workflow 依赖”的做法，但不复制可变引用。  
**目的**：让一次 CI 执行使用可审计、可回滚的 Action 代码版本。  
**价值**：DeepAuto 的 workflow 会领取 OIDC token、执行 CLI Agent 并连接控制面；依赖漂移不应自动进入这个信任边界。  
**验收**：建立 Action 清单，升级 Action 必须是显式 PR；高权限 workflow 的第三方 Action 固定到审核过的 SHA。

### A4. “工作流只负责执行”这一职责边界

**Grain 参考**：Niuma 的真实价值在于将 Agent 执行视为可追踪、可恢复的异步任务，而非一次无状态 shell 命令。  
**DeepAuto 当前状态**：这一原则已在 [05-cli-runtime-github-actions-harness-architecture.md](./05-cli-runtime-github-actions-harness-architecture.md) 中确立，并已经体现在 OIDC bootstrap、`execution_id` 和 Gateway 回调设计中。  
**复用决策**：不是新增功能，而是把它作为后续 workflow 评审的硬约束。  
**目的**：阻止新 workflow 把授权、用户身份、长期 token、最终状态或自动合并逻辑塞进 GitHub Actions。  
**价值**：保证 DeepAuto 即使以后替换 GitHub Actions、增加 Local Sandbox 或换 CLI runtime，也不会丢失任务历史、审计与权限判定。

## 4. B 类：必须改造后复用

### B1. Niuma 的会话续跑、状态卡片、取消与失败补发

**Grain 参考**：`.github/workflows/niuma.yml`、`.github/prompts/niuma.md` 以及 Niuma Harness。  
**改造方向**：

- 以 DeepAuto 的 `conversationKey`、`Job`、`Attempt`、`Execution` 为唯一关联键；
- Runner 只接收短期、任务绑定的 bootstrap/session claim；
- 状态更新由 Gateway 验签 callback 后写入数据库，不能由 workflow 日志推断；
- 取消与重试由 Dispatcher 决定；GitHub Actions 只接受 cancel 请求并上报结果；
- 飞书或 GitHub 原始 thread 是回执锚点，不是 session 或权限的真源。

**目的**：让“用户继续追问”“任务被取消”“暂时性失败后重试”“Runner 掉线”都成为可恢复的状态转换。  
**价值**：这是 DeepAuto 多用户 Agent 平台真正需要的可靠性能力；它避免用户在飞书或 GitHub 里只能看到一条失联的运行记录。  
**不应直接复制的部分**：Grain 的 runtime 目录缓存、模型名路由、飞书特例、GitHub 评论格式和 Niuma Harness Action 入参都属于其私有实现。

### B2. 最小 PR CI

**Grain 参考**：`ci.yml`、`doc-lint.yml`、`ci-runtime-go.yml` 的“快速确定性检查优先”原则。  
**DeepAuto 落点**：按 [07-testing-validation-implementation-plan.md](./07-testing-validation-implementation-plan.md) 新建一个针对 PR 与主分支的验证 workflow。  
**改造方向**：只执行 DeepAuto 已定义的 `lint`、`typecheck`、`test:unit`；集成测试仍由显式入口和真实 PostgreSQL/Redis 环境执行。  
**目的**：在 Agent 或人类创建 PR 后，给出确定性的代码正确性证据。  
**价值**：把“Agent 说已完成”与“仓库确实可通过静态检查和单测”分开，形成 DeepAuto 的第一道交付门槛。  
**不应复制的部分**：Grain 的 turbo 缓存 key、包路径过滤、Feishu 通知、合并分支归因都与 DeepAuto 不同。

### B3. 评论/事件触发的安全协议

**Grain 参考**：`visual-e2e-test.yml` 的固定 dispatcher marker、`niuma.yml` 的 sender/marker 防回环、`vercel-deploy.yml` 的 fork 保护。  
**适用前提**：DeepAuto 以后开放“在 GitHub Issue/PR 评论中召唤 Agent”或“由评论触发验证”。  
**改造方向**：

- 不把任意 `@deepauto` 文本当作可信执行命令；
- 由 Gateway/Dispatcher 写入带签名或不可伪造 run 标识的指令，workflow 只接受该协议；
- 对 fork PR 默认不授予写 token、OIDC claim 或可执行其 head 代码的权限；
- 使用 marker 防止 Agent 自己的状态评论再次触发 Agent；
- 真实授权仍由 GitHub App 安装、成员映射和 DeepAuto policy 决定。

**目的**：允许 GitHub 交互入口，而不把评论内容变成高权限命令注入面。  
**价值**：提前建立正确边界，避免未来补功能时引入 `pull_request_target` + fork head + secret 的经典高危组合。  
**当前结论**：只写协议与测试，不增加评论触发 workflow。

### B4. Agent Prompt 的“核心规则 + 按需引用”结构

**Grain 参考**：`.github/prompts/AUTHORING.md`、`base-rules.md`、`niuma.md`、`niuma-refs/**`。  
**DeepAuto 落点**：`.codex/` 的路径级上下文、后续 CLI runtime system prompt、代码审查 Agent。  
**改造方向**：共用文件只放不变量（授权、隔离、PR-only 交付、审计、敏感信息）；仓库写入、飞书读取、GitHub callback、取消/重放防护等细则按任务能力再加载。  
**目的**：让 Agent 在需要时得到准确限制，而不是在每次运行时携带一份不可维护的大 prompt。  
**价值**：更低的上下文噪音、更少的规则冲突，也更容易对高风险路径做针对性审核。  
**不应复制的部分**：Grain 的内容生产、频道、巡检、飞书组织人员、模型成本等语义。

### B5. 代码审查双层模型

**Grain 参考**：通用代码审查与专门审查组合，而不是只依赖一次 Agent review。  
**DeepAuto 落点**：`code-reviewer` 和 `execution-safety-reviewer`，见 [08-codex-project-configuration-plan.md](./08-codex-project-configuration-plan.md)。  
**改造方向**：审查问题必须围绕 DeepAuto 的 webhook 验签、OIDC claim、GitHub App 安装、workspace 隔离、状态机、幂等、取消竞争和 callback 重放。  
**目的**：让审查覆盖通用代码质量，也覆盖控制面/执行面边界。  
**价值**：比复制 Grain 的大型 `claude-code-review.yml` 更小、更可解释，也更贴合 DeepAuto 的真实风险。  
**当前结论**：先在本地 Codex 审查流程中使用；不急于构建多 job 的云端 AI 审查矩阵。

### B6. 执行结果的结构化摘要与失败分级

**Grain 参考**：Agent workflow 会收集运行摘要、失败原因、通知对象与后续路线，而不是只留下 Actions log。  
**DeepAuto 落点**：Gateway callback schema、Execution audit record、飞书/GitHub 回执适配器。  
**改造方向**：定义最小稳定字段，例如 `executionId`、`attemptId`、终态、失败类别、可安全展示的摘要、日志引用、是否可重试、人工下一步；禁止把 CLI 原始输出或 token 写回用户可见通道。  
**目的**：把 Runner 的技术结果转化为控制面可判断、用户可理解的事实。  
**价值**：支持可重试性、审计、客服排障和未来多执行器统一；避免依赖 GitHub Actions 的页面作为唯一运行记录。

### B7. 工作流、Prompt、脚本之间的依赖可见性

**Grain 参考**：workflow 与 Prompt、脚本已形成事实上的依赖图，但规模大时静态引用很难维护。  
**DeepAuto 落点**：只维护一份机器可验证的执行能力登记，而不是复制 Grain 的 49 个 Prompt 与 49 个脚本。  
**改造方向**：在 Dispatcher capability registry 或测试中声明：每种 Execution 使用哪个 workflow、允许哪些工具、需要哪些 callback、对应什么验证命令。  
**目的**：避免代码、workflow、Prompt、权限和回调协议改了一侧而另一侧静默失效。  
**价值**：当 DeepAuto 增加多个 executor 或代码仓库后，能显著降低排障与迁移成本。

## 5. C 类：满足条件后再考虑

| 能力 | Grain 参考 | 触发条件 | 届时目的与价值 | 当前不做原因 |
| --- | --- | --- | --- | --- |
| Workflow 健康巡检 | `workflow-health-patrol.yml`、`workflow-health-stats.ts` | 至少有 5 条长期运行 workflow，且偶发失败开始需要人工逐条查 | 聚合失败率、超时、连续失败和缺失定义，减少静默失效 | 目前只有一个执行 workflow，健康检查本身会比被检查对象复杂 |
| 巡检时间窗工具 | `patrol-window.ts` | 出现按北京工作日/自然日聚合的报告或巡检 | 让“检查哪段时间”的口径可测试，避免 cron 延迟漏数 | DeepAuto 现阶段没有生产巡检数据域 |
| 凭据/连接器探针 | `patrol-credential-probe.ts` | 飞书、GitHub、数据库、多个 MCP/第三方连接器均已进入生产 | 及早发现 scope、过期 token、连接器不可用 | 首期应由健康检查和显式错误返回覆盖，不能先造一个高权限巡检 Agent |
| 视觉 E2E + Preview | `visual-e2e-test.yml`、`preview.yml` | DeepAuto 自身有可部署 Web UI、稳定 Preview 和关键用户流程 | 在真实浏览器中验证登录、任务创建、状态查看等体验 | 当前核心风险在控制面正确性，不在页面视觉；Preview 会引入部署、域名与凭据复杂度 |
| 运行时会话缓存 | Niuma Harness 会话续跑 | 用户确实在同一 conversation 连续发起长任务，且冷启动成本成为问题 | 降低续问成本，保留必要上下文 | 先完成安全 session identity、取消、审计与状态机；缓存不能先于身份边界 |
| 中国工作日 Gate | `actions/china-workday-gate` | 运营日报或人工审批工作流明确要求只在工作日执行 | 减少无效通知和无效巡检 | 不属于代码执行主链路，不应为未来假设提前引入 |

## 6. D 类：不复用

### D1. 内容业务与运营 workflow

**不迁移范围**：视频失败/自迭代、SEO、网站性能、慢 SQL、支付健康、Affiliate、外联转化、Warmup、Smartlead 归档、种子用户表、潜在用户、正向回复、Landing 版本、Onboarding 发布验收等。  
**原因**：这些能力绑定 Grain 的频道、内容、营销、支付、飞书表结构、Vercel 项目和负责人，不是通用 Agent 平台能力。  
**结论**：绝不为“可能有用”复制 workflow、Prompt、脚本或 Secret 名称；DeepAuto 若未来有对应业务，应从自己的数据模型和 SLA 重新设计。

### D2. Grain 的多 runtime Harness 实现

**不迁移范围**：`DeepLangAI/niuma-harness` Action、Claude/Cursor/DeepSeek 的目录缓存、模型选择语法、运行时兼容层。  
**原因**：DeepAuto 已选择 `ExecutorAdapter`，其 runtime 路由、工具白名单、成本预算与凭证领取必须由自身控制面定义。直接依赖 Grain Harness 会让产品边界、版本节奏和安全模型耦合到另一个仓库。  
**结论**：只复用“runtime 可插拔”的抽象，不复用具体 Harness。

### D3. GitHub 事件直接充当控制面

**不迁移范围**：把 Issue、PR 评论、label 或 workflow run 当作任务状态、身份认证或权限真源。  
**原因**：这与 DeepAuto 的 PostgreSQL 真源、Gateway 验签、统一 Invocation 和审计设计冲突。  
**结论**：GitHub 事件最多是入口或回执载体；进入 DeepAuto 后必须标准化为内部 Invocation，并经过授权与幂等判断。

### D4. 自动修复后直接写默认分支、自动合并或自动部署

**不迁移范围**：任何绕过 DeepAuto PR-only 交付策略的快捷通道。  
**原因**：DeepAuto 面向多用户和多仓库，控制面不应替用户扩大代码写入权限。  
**结论**：Agent 只能创建任务分支、提交和 PR；合并与部署保持显式人工或独立受控流程。

### D5. 跨仓库 Secret 同步

**不迁移范围**：仿照 Grain 的 `secret-sync.json` 和 `sync-secrets.yml`，让一个仓库向多个仓库分发 Secret。  
**原因**：DeepAuto 的关键目标是短期、任务绑定凭证和 GitHub App/OIDC；集中复制长期 Secret 会扩大可泄露面，也让权限撤销和审计更复杂。  
**结论**：不引入。跨仓库能力应由 Vault/云身份、GitHub App installation token 或 OIDC federation 解决。

### D6. 大型云端 AI 审查“战斗编排”

**不迁移范围**：多模型互评、自动再跑、评审对战、长时间 review matrix。  
**原因**：它需要稳定的模型质量基线、较高的 Actions 预算、成熟的 PR 流量和可靠的结果消费协议；DeepAuto 现在更需要确定性测试和针对执行边界的审查。  
**结论**：不预埋。先让 `lint`、`typecheck`、单测、集成测试和必要的安全审查成为可信基线。

### D7. Grain 的部署/Preview/SSH 编排

**不迁移范围**：SSH 部署、PM2、Vercel alias 回收、Testing/Stashing 环境、EAS 发布、FFmpeg Runner。  
**原因**：这些是 Grain 当前基础设施的实现细节，且会引入长期 SSH 私钥、环境清理和发布责任。  
**结论**：DeepAuto 在自身部署方案确定前不借用；即使未来需要部署，也优先设计无 SSH 私钥常驻的环境身份方案。

### D8. “为每项运营活动各建一个手动 workflow”的模式

**不迁移范围**：大量彼此独立的 `workflow_dispatch` 入口。  
**原因**：DeepAuto 已有 Dispatcher 和统一任务模型；重复创建 GitHub 表单会让参数验证、权限检查、审计和用户体验分裂。  
**结论**：保留一个受控制面派发的执行 workflow。需要运维入口时，优先在 DeepAuto 控制台或受鉴权 API 上实现。

## 7. 推荐的落地顺序

### 第一步：补齐确定性验证与 workflow 安全基线

1. 为 DeepAuto 新增最小 PR CI：`lint`、`typecheck`、`test:unit` 与 `actionlint`；先观察稳定性，再设为 required checks。
2. 已验证 `deepauto-execute.yml` 使用 `github.token` 在 Codex 退出后 push 任务分支并创建 PR，因此保留 `contents: write` 与 `pull-requests: write`；后续仅评估是否可拆分 delivery job 来缩小可见范围。
3. 为现有执行 workflow 增加与 `execution_id` 一致的并发语义；同一 conversation 已决定顺序排队，并在控制面明确 cancel/retry 的终态规则。
4. 对所有 Action 建立 pin 与更新策略；不要复制 Grain 的可变 tag/`@main` 方式。

### 第二步：在控制面完成可靠执行闭环

1. 定义 callback 的结构化终态、失败分类和安全展示摘要。
2. 将重复 dispatch、取消、超时、回调重放、Runner 无响应纳入 `Attempt` 状态机测试。
3. 让飞书/GitHub 回执只读取控制面已验证的状态，而不直接解析 runner 日志决定结果。
4. 将 session resume 作为受控能力：先验证同一 conversation 的身份与工作区一致，再允许复用。

### 第三步：只在真实需求出现后扩展

1. GitHub 评论召唤、工作流健康巡检、连接器探针、Preview/视觉 E2E 都必须有明确使用者、数据源、权限模型和验收指标。
2. 每扩展一项都先问：它能否由现有 Dispatcher/Executor 能力完成？若可以，不新增 workflow。

## 8. 成功判据

- GitHub Actions 配置错误在 PR 阶段被发现，而不会阻塞已经派发的 Execution。
- 同一 DeepAuto Execution 不会因重复 dispatch 或 GitHub 重跑而出现两个并发修改者。
- GitHub Actions 不能获得超出当前任务所需的长期凭证或默认仓库写权限。
- Agent 的成功、失败、取消和重试都能由 DeepAuto 数据库中的状态机解释，而不是依赖日志猜测。
- DeepAuto 的 workflow 数量保持少且职责单一；没有复制任何 Grain 内容运营、营销、发布或跨仓库 Secret 自动化。
- 新增的任何 Agent 能力都能说明它复用的是哪项已验证原则、权限如何受限、失败时由谁处理，以及如何证明其收益。
