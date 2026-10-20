# DeepAuto Agent：测试与验证机制实施方案

> 状态：**阶段 A、B、C 已本地实现并验证；阶段 D 的受控假 CLI Harness 协议已实现并验证。Codex CLI、隔离 GitHub 测试仓库与最小权限 GitHub App 已准备；远端 CI / 分支保护、真实 runtime 接入和隔离仓库冒烟仍待实施**
> 编写日期：2026-10-19  
> 适用范围：DeepAuto 平台代码、飞书与 GitHub 入口、异步任务、CLI Harness 及其代码交付  
> 参考：[统一 Agent 平台架构](./03-unified-agent-architecture.md) · [开发工具链基线](./04-development-toolchain-baseline.md) · [CLI Runtime 与 GitHub Actions Harness 架构决策](./05-cli-runtime-github-actions-harness-architecture.md) · [Grain 的代码测试与验证机制](./06-grain-code-validation-mechanisms.md)

## 1. 要解决的问题与验收定义

DeepAuto 目前有测试、类型检查、构建和 Lint 的根命令，但 workspace 尚无业务源码及对应脚本。本地实测 `bun run test`、`bun run typecheck`、`bun run build` **执行 0 个 Turbo task、退出码仍为 0**。如果直接在此基础上编写 Gateway、Worker 或 Harness，绿色结果不能证明代码经过验证。

本方案先让**验证机制本身可被验证**，再让每项业务能力带着对应测试进入仓库。实施前的“0 task 也成功”结果作为问题基线保留；阶段 A 的实际进展记录在第 9 节。完成后的合格标准：

1. 每个被纳入验证的模块都有实际执行的检查；无检查、测试意外缺席、应运行的 suite 被跳过均不能“假绿”。
2. 可确定的系统行为由可重复的自动测试守护；模型回答质量另外评测，不用逐字快照充当系统正确性证明。
3. PR 和合并后的主分支运行同一套基本检查；检查失败时不能以 Agent 的“看起来没问题”代替证据。
4. 权限、跨用户隔离、任务去重、取消和外部写入等高风险边界有正反例，且真实 PostgreSQL/Redis 行为不能只靠 mock 证明。
5. 测试环境不使用开发库、生产密钥和真实用户资源；引入的验证设施不会扩大 CLI Agent 或 GitHub Actions 的权限。

本方案**不决定**尚未在产品架构中确定的首个 CLI runtime、首个业务任务或最终生产部署平台；它们不阻碍基础验证机制先落地。

## 2. 原则和范围

### 2.1 两种证据分开

| 证据 | 适用对象 | 合并判据 |
| --- | --- | --- |
| 确定性硬门 | 类型、构建、Lint、签名、授权、状态转换、数据唯一约束、任务副作用、Runner 策略、回调协议 | 有明确预期；失败时 PR 不可合并 |
| 真实链路冒烟 | 飞书测试应用、GitHub 测试仓库、真实容器或 CLI runtime | 在隔离环境运行；失败需诊断，不把它误记为单测通过 |
| 模型效果评估 | 工具选择、任务完成率、回答/代码质量、成本与耗时 | 固定任务集、版本对照与人工复核；不靠单次随机输出逐字通过 |

首期不设“覆盖率达到某百分比”这种替代指标。必须测的是不可逆动作、鉴权与隔离边界、真正会算错的转换，以及出现过的回归问题；简单透传不为了数字堆测试。**测试是否有效**的最低判据是：破坏被测行为时，它确实会失败。

### 2.2 按现有架构安排验证

- 本机与 CI 沿用现有 TypeScript、Bun `1.4.2`、Turbo `2.11.9`、Biome `2.4.12`、Node `22.23.3`、Prisma `7.8.0`、PostgreSQL 16 和 Redis 7；不为测试引入第二业务语言或完整浏览器测试栈。
- 使用 Bun 内建测试运行器，优先以明确的文件/目录入口区分单测、集成测试和冒烟；不让裸 `bun test` 在仓库根目录误扫所有测试。
- 测试贴着负责该逻辑的包；跨 Gateway、Worker 和数据库的链路测试放在独立的项目级 `tests/integration/`，不分别造三套端到端框架。
- DeepAuto 自身的 **PR 验证 workflow** 与以后执行用户代码任务的 **GitHubActionsExecutor workflow** 是两种不同职责；用户任务 Runner 的自报“测试通过”不能代替 DeepAuto PR 的独立 CI。
- PostgreSQL 是 Job、授权与审计真源；验证 DB/Redis 的失败恢复必须使用真实服务。模型、飞书与 GitHub 外部 API 在通用 CI 里用可控替身，另开受控真实冒烟。

## 3. 预定的验证入口与目录

实施时先落一套固定命令，确保本机与 CI 运行同名入口，而不是把验证细节写散在 workflow 中：

| 根命令（拟定） | 责任 | 进入主 CI 的时机 |
| --- | --- | --- |
| `bun run verify:targets` | 校验应参与验证的模块、脚本和 suite；禁止意外的 0 task / 0 test | 阶段 A 起，始终必跑 |
| `bun run lint` | Biome + 少量实际必要的项目不变量检查 | 阶段 A 起 |
| `bun run typecheck` | 活跃 workspace 的 TypeScript 类型检查 | 阶段 A 起 |
| `bun run build` | 构建实际可执行/可发布产物，不仅仅做 `noEmit` | 阶段 A 起，随模块启用 |
| `bun run test:unit` | 无真实 DB/Redis/外部服务的确定性单测 | 阶段 A 起 |
| `bun run test:integration` | 使用隔离 PostgreSQL/Redis 的跨模块测试 | 阶段 B 起；当前已覆盖投递/业务幂等、BullMQ 入队去重与会话锁 |
| `bun run test:smoke` | 隔离飞书应用、测试仓库、真实 CLI 的人工/受控环境冒烟 | 阶段 D 起，不进无凭证 PR CI |
| `bun run test:eval` | 固定任务集的模型效果评估与对照报告 | 阶段 D 起，独立于硬门 |

继续保留 `bun run test` 作为易记入口，但把它明确映射到当前已启用的**确定性**测试，不把需要真实外部凭证的冒烟或模型评估悄悄混进去。根脚本和各包脚本由 Turbo 组织；仓库根部的验证脚本测试须显式纳入 `test:unit`，避免 workspace 之外的测试文件无人运行。

建议的目录职责（按需创建，不现在批量建空目录）：

```text
scripts/
  check-validation-targets.ts       # 活跃模块和测试入口防空跑检查
  check-validation-targets.test.ts  # 用缺脚本、漏 suite 等反例测试门禁本身
apps/<name>/src/**/*.test.ts        # Gateway / Worker 纯逻辑单测
packages/<name>/src/**/*.test.ts    # 领域契约、Provider、策略、Runner 纯逻辑单测
tests/integration/                  # 真实 DB/Redis 的跨模块场景
tests/fixtures/                     # 脱敏的飞书/GitHub 事件及 CLI 事件流
tests/smoke/                        # 受控外部环境冒烟脚本
evals/                              # 后续固定任务集及评分规则
.github/workflows/validate.yml      # DeepAuto 自身 PR / main 验证
```

**防空跑约束**：`verify:targets` 根据仓库内有实际 TypeScript 源码的 workspace 建立受检集合；一旦模块开始写业务源码，就必须有真实 `lint`、`typecheck`、`build` 入口，以及按其风险对应的单测或集成 suite。暂时只有 `package.json` 的包可以标为 scaffold-only，但不能借此逃避源码检查；初始验证基座本身也必须至少执行一个真实测试（门禁脚本的正反例），不能通过空配置获得绿色。suite 从文件发现或唯一注册处派生，避免“本地有测试、CI 清单漏了它”。

## 4. 测试层的具体设计

### 4.1 纯逻辑单测：快、无外部依赖

| 负责模块 | 第一批必须钉住的行为 | 关键反例 |
| --- | --- | --- |
| `packages/contracts` | `Invocation`、Job/Attempt 状态、来源锚点和 `conversationKey` 的解析与校验 | 非法状态跃迁、缺失资源归属、不同 thread 错并为同一会话 |
| `apps/gateway` | 飞书私聊/群 `@bot` 的准入、过滤 bot 自身消息、来源事件标准化；GitHub Webhook 事件与签名验收 | 未 @ 就启动、伪造来源/签名、同一事件产生不同幂等键 |
| `packages/agent-core` | 工具 `read/write/high-risk` 准入、GPT/DeepSeek 可降级边界、任务预算 | 未授权工具放行、外部副作用后从头重跑、权限错误当供应商故障降级 |
| `packages/lark` / `packages/github` | Provider 输入校验、身份/资源映射、回调和 API 错误归一 | 错误用户身份、未知仓库/分支、供应商响应未知时误记为写入成功 |
| `packages/runner-manager` | 仓库 allowlist、默认分支禁写、执行参数与产物边界 | 任意镜像、宿主 Docker Socket、默认分支推送、超预算或多余凭证 |

这些单测用固定输入、注入时钟、随机数和外部客户端替身。模型不参与签名、授权、分支保护或状态机裁决。Provider 的纯转换可单测，但 HTTP/SDK 调用本身另由集成或受控冒烟证明。

### 4.2 PostgreSQL / Redis 集成测试：验证真实持久化与竞态

集成测试使用专门的临时 PostgreSQL 数据库和 Redis 实例/命名空间，执行项目正式 Prisma migration，不对现有 `deepauto` 开发库做清库、`migrate reset` 或覆盖。测试启动时校验 `NODE_ENV=test` 和测试库标识，拒绝指向生产或日常开发 DB 的 URL；各场景的记录、队列名和锁 key 独立，完成后清理本次测试拥有的资源。

首批场景：

1. 同一飞书 `event_id` 重投、同一 GitHub delivery 重投，只创建一份 Invocation/Job；业务幂等键与投递键分别守护。
2. 两个 Worker 同时消费同一会话，至多一个拥有执行权；不同会话仍可并行。
3. DB 已写入而入队失败、入队后 Worker 崩溃、执行超时后重投，Job 不丢失也不重复执行外部写入。具体修复机制采用实现时选定的 outbox/补偿策略，测试先固定可观察结果。
4. 同一 `attemptId` 的重复终态 callback 不重复发回执；过期 attempt 的 callback 不覆盖新的 attempt。
5. 取消与完成并发时只有一个合法终态；取消旧 run 不会停止同 thread 的下一次任务。
6. 凭证领取 claim 过期、重放、actor/workspace/attempt 不匹配时拒绝；审计记录可追溯且不含明文 token。
7. 若加入用户 OAuth，验证刷新 token 轮换的并发互斥及不同用户资源隔离。

优先用正式 PostgreSQL 唯一约束与事务、真实 BullMQ/Redis 行为证明这些结论；不能把内存 Map 的测试当作它们的替代。CI 用临时 service containers，本机使用独立测试 Compose/测试端口或隔离实例，严禁复用已有业务库的凭据。

### 4.3 Harness / GitHub Actions：先测试协议，再验证真实交付

首个 CLI runtime 尚未选定，但以下协议可以先用**可控的假 CLI 进程**验证：

- 启动参数、工作目录、任务绑定身份与超时预算；
- 结构化事件流从 `started` 到 `completed/failed` 的归一、缺失终态、乱序与重复事件；
- CLI 非零退出、超时、取消、Runner 崩溃后的最终状态和临时目录回收；
- 重复 callback、伪造 claim、错误仓库或错误 `attemptId` 的拒绝；
- diff、测试结果、提交 SHA、PR 链接等产物的可信来源和缺失处理；
- 不给模型进程宿主 Docker Socket、长期 token、数据库连接串或默认分支写权限。

随后才在一个隔离测试仓库里，用真实 GitHub App 和选定的单一 CLI runtime 做一次“任务 → 非默认分支 → 验证 → Pull Request → DeepAuto 回执”的冒烟。Runner 自报的测试摘要只是该任务的产物证据；PR 的代码质量仍由**测试仓库自身 CI**对实际提交 SHA 独立验证。首期不自动合并或部署。

### 4.4 模型效果评估：独立而可对照

待可调用的 Agent 链路形成后建立小型、固定的任务集：只读飞书问答、权限不足时拒绝、明确写入意图、代码任务的测试/PR 交付、供应商故障但无副作用时降级、已有副作用时停止重跑。为每个 case 保存输入、授权背景、允许工具、禁止动作和评判规则；不保存真实用户密钥或未授权私有正文。

报告至少呈现：任务完成率、越权/错误写入次数、重复副作用、工具调用有效性、成本、耗时，以及失败案例与模型版本。自动 PR 阶段可以做**无真实模型的装配检查**；真实模型评估在受控环境运行，数据量足够后再决定是否设稳定阈值。不能因为一次成功采样宣布模型质量“已验证”。

## 5. CI 设计：先简单、再根据实测拆分

首期只有 `main` 分支时，新增一个固定名称的 `validate` workflow，对**每个 PR（包括只改文档的 PR）**以及 `main` push 运行；不使用 `paths-ignore` 让未来必需检查无故缺席。工作流固定 Bun 与 Node 版本，在无生产 secret 的 runner 中安装锁定依赖。核心顺序：

```text
checkout 当前 PR 待合并版本 / main 提交
  → setup Node 22.23.3 + Bun 1.4.2
  → bun install --frozen-lockfile
  → verify:targets
  → Prisma client generate（数据库模块启用后）
  → lint / typecheck / build / test:unit
  → 启动或等待独立 PostgreSQL/Redis 测试服务
  → prisma migrate deploy 到全新测试库（数据库模块启用后）
  → test:integration（阶段 B 启用后）
  → 汇总检查结论
```

具体 workflow 文件在实施时生成，不在本方案中提前写一份可能与脚本不符的 YAML。首期优先一个稳定的必需检查名；若执行时间与成本实测需要，再拆静态/单测/集成 job，并确保汇总 job 不会把 skipped 当 success。安装失败不继续跑伪错误；安装成功后尽量保留各项失败的独立输出。CI 不用长期 Lark/GitHub token、不跑真实模型、不启动可访问生产资源的代码 Runner。外部 staging 冒烟另设人工或受控触发，避免 fork PR 读取密钥。

实施后需要由仓库管理员在 GitHub 配置 `main` 的必需检查、禁止绕过失败状态的合并策略与审查要求；**workflow 存在并不等于分支保护已启用**。`main` 合并后再次运行同一验证命令；失败必须通知负责人并留下可定位的 run/commit，不让主分支长期“红而无人知”。

## 6. 分阶段交付：每阶段都有反向验收

| 阶段 | 实施内容 | 完成门槛 |
| --- | --- | --- |
| **A：验证基座** | `verify:targets` 及其反例测试、真实包脚本/TS 配置、明确的单测入口、最小 `validate.yml`、锁定依赖安装 | `test/typecheck/build/lint` 不再因 Turbo 0 task 而成功；故意删脚本/测试、制造类型/格式/断言/构建错误时对应本地命令与 PR CI 变红，恢复后变绿 |
| **B：真实依赖层** | 隔离测试 DB/Redis、Prisma migration 运行、BullMQ/状态/去重/竞态测试、本机与 CI 同名集成测试 | 在测试库通过；把 URL 指向日常或生产库时拒绝；破坏唯一约束、会话串行或重投幂等时明确失败 |
| **C：入口与授权层** | 飞书/GitHub 脱敏事件 fixture、签名与 actor 校验、工具准入、凭证 claim 与出站幂等 | 私聊/群 @/GitHub 入口的正例通过；伪造来源、越权、重复事件及重复回执均被拒绝或去重 |
| **D：执行器与评估层** | 假 CLI Harness 协议测试、隔离测试仓库的真实冒烟、固定 Agent 任务集与报告 | 超时/取消/重复 callback 不丢失终态；仅允许仓库的非默认分支生成可审查 PR；评估可重跑并呈现失败/成本，不用单次样本充当硬门 |

阶段 A 可以与第一个真实领域契约的小改动一起实现，避免为了“有一个测试”永久保留无业务意义的假用例；但门禁脚本自己的正反例本身就是有价值的首批测试。**阶段 A 未通过，不开始大量 Gateway/Worker/Harness 业务代码。**后续阶段跟随功能逐步启用，不要求为尚未开发的飞书写工具或 CLI runtime 写占位测试。

## 7. 失败处理、维护和明确不做的事

- 测试失败先分为代码回归、测试环境故障、上游服务故障和随机模型波动；不得通过降低断言、忽略退出码、无限重试或把 skipped 写成 success 来“修绿”。
- 对确有环境抖动的步骤先找根因，再考虑有限重试；权限/数据隔离/幂等测试不允许“多跑几次总会过”。
- 固定的 fixture 需要脱敏且附来源场景；用户数据和密钥不能提交。测试中只存结构、事件 ID、资源归属等必要字段。
- 测试名字表达可观察的不变量；修复线上 bug 时先留下能复现的测试，别为内部实现细节拍大面积快照。
- 业务 PR 描述至少说明改了哪个用户可触发行为、跑了哪些定向检查、什么没有跑及原因、是否涉及权限/数据/副作用。Agent 写代码与人工写代码走同一套门禁。
- 首期**不复制** Grain 的高成本缓存、复杂 AI 互审、所有 Preview 基建、海量包级脚本或固定覆盖率百分比。只有跑出瓶颈、出现特定遗漏，再按证据加机制。

## 8. 执行前需要确认的决策

本方案默认采用 Bun 内建测试运行器、独立 PostgreSQL/Redis 测试环境、GitHub Actions 的无密钥 PR CI，并以一个稳定的必需检查为首期形式。开始实施前请确认：

1. **同意把“阶段 A：验证基座”作为下一次实施范围**，暂不同时接飞书业务功能或 CLI runtime。
2. Gateway/Worker 最终部署进程是 Node 22 还是 Bun？现有文档固定 Node 22 作为 Docker/CI/Runner 基线、Bun 用于本地脚本与测试，但实际服务启动/构建产物尚未定型；实施 `build` 脚本前要锁定这一点。
3. DeepAuto GitHub 仓库及 `main` 分支保护由谁配置？此项需要仓库管理权限，代码里的 workflow 无法替代远端设置。
4. 集成测试本机采用单独的测试 Compose，还是项目现有 Compose 内独立的测试库/Redis 命名空间？方案要求**绝不复用日常开发库**，具体隔离手段按本机习惯确定。

本轮已经获准启动实施，并已完成阶段 A 的本地代码与故障注入验证、阶段 B 的隔离数据库/Redis、持久化 Job、outbox 恢复和任务终态验证，以及阶段 C 的可控入口/身份/claim 验证。真实飞书连接、GitHub App 安装状态和用户 OAuth 等外部链路继续按实际功能落地顺序推进。

## 9. 实施记录（2026-10-20）

| 事项 | 当前结果 |
| --- | --- |
| 阶段 A 验证入口 | 已实现 `verify:targets`、`lint`、`typecheck`、`build`、`test:unit`；根 `test` 映射到确定性单测；首个活跃包为 `packages/contracts`，其它空包保持 scaffold-only |
| 实际执行 | 门禁自测 5 条、Invocation 契约测试 3 条；Turbo 的构建、类型检查、Lint 与单测均有非零任务，构建后的门禁脚本也会再次执行 |
| 反向验证 | 临时错误注入：失败单测使 `test:unit` 退出 1；类型错误使 `typecheck` / `build` 退出 2；格式错误使 `lint` 退出 1。注入文件已删除 |
| PR CI | 已添加 `.github/workflows/validate.yml`；远端 GitHub Actions 运行结果尚未取得，不能声称远端已绿 |
| 分支保护 | 仍需仓库管理员配置并核对 `main` 必需检查与合并策略；仅有 workflow 文件不等于已强制门禁 |
| 阶段 B（基础） | 已新增 `compose.test.yaml`（独立 `5433` / `6380` 端口）、`packages/db` 的 Prisma schema 与工具生成的 migration；集成入口先拒绝非 `NODE_ENV=test`、非本机、错误库名或开发端口，再运行正式 migration。真实 PostgreSQL/Redis 测试验证了来源投递去重、业务幂等、BullMQ 以持久化 Job ID 去重，以及同会话互斥/不同会话并行 |
| 阶段 B（恢复与终态） | 已实现事务 outbox、发布失败后的保留与真实 BullMQ 重放、超时 Attempt 的失败标记与重入队、重复终态 callback 去重、过期 Attempt 不覆盖新 Attempt、取消与完成竞争时只允许一个终态，以及取消旧 Job 不影响同会话下一 Job。当前集成 suite 共 9 个场景、37 个断言 |
| 阶段 C（入口与授权） | 已实现飞书文本消息的 bot 自身过滤、群聊 `@bot` 准入和标准化；GitHub `issue_comment` 的 SHA-256 HMAC 验签、显式 mention 准入、事件标准化；Gateway 在签名验收后执行成员映射、GitHub 仓库 allowlist 和持久化任务创建。真实 Gateway 集成测试验证了“签名 webhook → 已关联成员/已 allowlist 仓库 → 仅创建一个 Job”及未关联成员的拒绝 |
| 阶段 C（凭证 claim） | 已实现绑定 `workspaceId + actorId + attemptId` 的一次性 claim；真实数据库测试覆盖过期、actor/attempt 错配、顺序重放与并发重放，并确认审计 metadata 不保存 credential reference。用户 OAuth refresh-token 轮换仍待 OAuth 能力进入仓库 |
| 阶段 C（外部连接） | 飞书 SDK 长连接和受控 staging 冒烟尚未实现；`liaowenjie15/deepauto-harness-sandbox` 已作为隔离仓库创建，GitHub App 已按最小权限安装，但平台尚未使用真实凭证调用它。当前测试仍只使用脱敏 fixture、HMAC 与本地隔离服务。 |
| 阶段 D（Harness 协议） | 已实现受控假 CLI Harness：仅允许已有绝对工作目录、受限环境变量和最长一小时超时；JSONL 事件必须以 `started` 开始并绑定同一 `attemptId`，终态顺序、必需产物和退出码均被校验。单测已覆盖工作目录绑定、环境中不泄露数据库/GitHub/Docker 凭证、非零退出、缺失或重复终态、伪造 attempt、取消、超时及产物缺失。此阶段不等同于已接入真实 CLI runtime 或 GitHub Actions |
| 阶段 D（执行记录） | 已实现 `JobAttempt → Execution → Artifact` 的持久化回执链路。回执 claim 只能在未过期、同一运行中 Execution 上使用一次；成功回执会在同一事务中保存有序事件、可信产物并完成 Attempt/Job。集成测试还覆盖跨 attempt 伪造、过期/并发重放、取消后回执拒绝且不消耗 claim，以及超时恢复同步将 Execution 标为 `TIMED_OUT`；全程仅使用本地 PostgreSQL，不引入真实凭证 |
| 阶段 D（Worker 协调闭环） | 已新增受控本地 Worker 协调器：按 `conversationKey` 领取 Redis 锁，领取 Job Attempt，创建 Execution/一次性回执 claim，调用可注入 Harness，并将规范化终态原子写回。真实 PostgreSQL/Redis 集成测试覆盖完成闭环、会话已被占用时 `deferred` 且不创建 Attempt，以及 Harness 在产生结果前抛错时记录可追溯失败。`test:integration` 现会先构建 workspace，避免测试解析陈旧 package `dist` 产物 |
| 阶段 D（外部冒烟与评估） | 首期 runtime 已确定为固定版本的 Codex CLI；隔离 GitHub 测试仓库、正常修改/失败/超时/无修改 fixture 与最小权限 GitHub App 已准备。`packages/github` 已实现 GitHub App JWT/installation-token、workflow dispatch 及 GitHub Actions OIDC 的 issuer/audience/repository/workflow/ref/event 校验，`packages/runner-manager` 已实现只派发固定 sandbox workflow 且仅传 `execution_id` 的 `GitHubActionsExecutor` 基础。Gateway 新增 OIDC 认证的 bootstrap/callback 路由：仅在可信 Action 身份下返回当前 Execution 的任务上下文；回调由控制面内部读取并消费一次性 callback claim，claim 不进入 workflow inputs、环境变量或日志。Worker 尚未接入该异步 executor；Codex 短期认证、Actions workflow、真实 PR 创建、外部 staging 冒烟及固定模型评估集/报告仍未实现。 |

阶段 A、B、C 与阶段 D 的假进程协议、执行记录、防伪、去重及受控 Worker 协调闭环均已落地；远端 `Validation` 与 `main` 必需检查也已验证并启用。GitHub Actions 的安全派发与 OIDC bootstrap/callback 边界已建立：下一步应实现沙箱 Actions workflow，并为 Codex 配置不向 CLI 暴露长期凭证的认证代理，再把异步 executor 接入 Worker 和执行真实 PR 冒烟。当前 Worker 协调器不自行选择仓库、分支、镜像、模型或长期凭证。
