# Grain 的代码测试与验证机制：DeepAuto 参考基线

> 状态：调研记录；不是 DeepAuto 已实现的 CI 规范  
> 核对日期：2026-10-19  
> 相关文档：[统一 Agent 平台架构](./03-unified-agent-architecture.md) · [开发工具链基线](./04-development-toolchain-baseline.md) · [CLI Runtime 与 GitHub Actions Harness 架构决策](./05-cli-runtime-github-actions-harness-architecture.md)

## 1. 核心结论

Grain 的验证不是“写完代码跑一下测试”，而是多层、分工明确的证据链：

```text
本地定向检查和提交前自动修复
  → PR 的类型检查、构建、Lint、单测和脚本测试
  → 需要部署的变更在 Preview 上运行真实链路 E2E
  → Agent / Prompt 变更另做装配检查和真实效果验证
  → 评审基于当前提交的 CI / Preview 结果作结论
  → 负责人合并
  → dev / main 合并后重新运行 CI，失败时告警
```

对 DeepAuto 最重要的不是搬来 Grain 的全部 workflow，而是先确保：**每项检查确实执行、失败能拦截、关键副作用与权限边界有确定性断言、模型效果不冒充确定性单测**。

本文提到的 `Grain` 文件路径均相对 Grain 仓库根目录。调研以实际脚本、测试和 workflow 为准；仓库文档可能滞后。没有读取 GitHub 远端分支保护配置，因此不能据此断言哪项检查已被平台设置成 required check。

## 2. 本地提交前：便宜、快速，但不是最终门禁

Grain 根 `package.json` 的 `prepare` 将 Git hook 路径设为 `.githooks`。提交时 `.githooks/pre-commit` 调用 `scripts/precommit-autofix.ts`：

- 只处理**已暂存**的相关代码与配置文件，运行项目锁定版本的 Biome 自动修复；
- 对飞书翻译目录的 `.po` 文件做 location 归一化；
- 自动修完会重新暂存；仍存在无法自动修复的 error 时拒绝提交；
- 不执行全部单测、E2E，也不代替 PR 的 CI；暂存了部分 hunk 时，自动重新暂存可能把同一文件的未暂存修改一并带入，需要提交者检查 diff。

开发者在改动附近先跑定向测试，再在需要时执行根脚本 `bun run typecheck`、`bun run lint`、`bun run test`。Grain 的 `bun run test` 通过 Turbo 运行指定 workspace 的测试；单独的 `bun run test:skills` 负责 workspace 之外的 Skill、hook 和仓库脚本测试。**`bun run test` 不等于裸 `bun test`**，后者可能扫描到原本独立运行的 Playwright spec。

参考来源：Grain `package.json`、`.githooks/pre-commit`、`scripts/precommit-autofix.ts`、`docs/testing.md`。

## 3. PR 主 CI：确定性的通用检查

Grain 当前的 `.github/workflows/ci.yml` 在 `pull_request` 和向 `dev` / `main` 的 `push` 上运行。实际配置是**一个 `check` job 顺序执行**以下步骤：

| 步骤 | 它能拦住什么 | 不能证明什么 |
| --- | --- | --- |
| 安装锁定依赖 | 依赖可安装、项目环境可重建 | 业务逻辑正确 |
| `bun run typecheck` | TS 类型契约、包间类型不一致 | 运行时外部状态正确 |
| 后端构建 | bundler、导出或生成链路错误 | 服务启动后的完整行为 |
| `bun run lint` | Biome 规则和项目专有静态约束 | 模型回答质量 |
| Agent 工具面检查 | 默认暴露的工具符合预定装配边界 | 所有调用都被正确授权 |
| `bun run test` | workspace 中的确定性单测 | 真实 DB/Redis、完整飞书或 GitHub 链路 |
| `bun run test:skills` | workspace 外的技能与自动化脚本回归 | 真实运行时效果 |

安装成功后，各检查以条件独立继续运行：即使类型检查失败，也尽量让构建、Lint 和测试输出自己的错误，避免作者一次只修出一个失败。安装失败时跳过后续检查，避免同一安装故障产生大量无意义的红项。

当前 CI 针对 backend 做显式构建：Web 构建交由对应部署平台的 PR 流程处理，移动端也不为无人消费的产物重复构建。Turbo 按内容缓存任务；Bun、构建缓存和增量类型检查缓存的具体优化是项目在已有规模下实测的成本取舍，**不是 DeepAuto 在零实现阶段需要复制的基建**。

**文档漂移提醒**：Grain `docs/cicd.md` 的部分章节仍描述 `static / unit / scripts` 三条并行 matrix；当前 `.github/workflows/ci.yml` 已改为一条串行 `check` job。以后借鉴执行细节必须以 workflow 本身为准。

参考来源：Grain `.github/workflows/ci.yml`、根 `package.json`、`packages/backend/package.json`、`turbo.json`。

## 4. 测试分层：按风险与依赖选择测试

Grain 的约定是测试贴着被测包；不为每段透传代码机械地增加单测。必须重点保护四类：不可逆动作的闸门、鉴权和数据隔离、真实算法与数据转换、线上复现过的 bug。

| 测试层 | Grain 中的做法 | DeepAuto 值得借鉴的场景 |
| --- | --- | --- |
| 纯逻辑单测 | 测可计算错误的纯函数；后端单测集中在 `packages/backend/src/tests/unit/` | 事件解析、签名验证逻辑、会话键、权限决策、状态转换、失败分类、回调校验 |
| 有依赖的集成 / E2E | 需真实 DB、Redis、服务或容器时，放到单独 suite，不把大量网络/数据库副作用混进单测 | 唯一约束、事务、BullMQ 重投、Worker 重启、任务锁、凭证领取 |
| 独立冒烟与复现 | 真实外部凭证或专用设备才可运行的脚本与通用单测分离 | 飞书测试应用、GitHub 测试仓库、真实 CLI runtime 产物回执 |
| Agent 效果评测 | 与类型/代码单测分离，以固定任务集和运行证据判断 | 工具选择质量、任务完成率、误写风险、成本与耗时 |

Grain 的 Niuma 派发相关测试不是断言模型会说出某句话，而是断言：超长任务不会超过 workflow input 预算、瞬时失败会回队首、永久失败会告警、超过窗口才进入终态、终态告警失败时不丢任务。这类**失效模式测试**比大量 happy-path 测试更适合 DeepAuto。

测试还需要防“看起来有覆盖、实际没执行”。Grain 的 `scripts/check-e2e-suite-parity.ts` 会校验本地 suite 清单和部署侧执行清单一致，避免新增 suite 后 Preview 报告全绿但漏跑了新测试；`scripts/check-unit-test-purity.ts` 防止需要真实依赖的副作用测试混进单测。

参考来源：Grain `CLAUDE.md`、`docs/testing.md`、`packages/backend/src/tests/unit/services/niuma-dispatch-drainer.test.ts`、`packages/backend/src/tests/unit/feishu/niuma-dispatch-payload.test.ts`、`scripts/check-e2e-suite-parity.ts`、`scripts/check-unit-test-purity.ts`。

## 5. Preview E2E：检验真实部署链路

Grain 的 `.github/workflows/preview.yml` 对需要部署的 PR 准备 Preview 环境，并调用 `.github/scripts/run-e2e-suites.sh` 运行 E2E；纯文档、CI 配置等不涉及部署的变更可以跳过部署，不让这类 PR 空耗环境成本。

后端 E2E 提供本地入口 `packages/backend/src/tests/e2e/run-local.ts` 和 suite runner：可以按 suite 单跑或全跑；全量按固定顺序执行，前置 suite 失败时停止更深的验证，并能输出结构化 JSON 结果。Preview 会把结果写回 PR。这里需要区分三种事实：**通过了、按规则跳过了、应运行但缺失或失败了**；不能把“没拿到结果”当成功。

Grain 的完整 E2E 部分依赖真实环境，不全部纳入通用 `bun run test`。这不是放弃覆盖，而是让不同测试跑在具有对应前置条件的位置。DeepAuto 初期可以先用可隔离的本机 PostgreSQL/Redis 跑集成测试，等 GitHub App、飞书测试应用和 CLI Harness 落地后再加外部系统的 staging 冒烟。

参考来源：Grain `.github/workflows/preview.yml`、`.github/scripts/run-e2e-suites.sh`、`packages/backend/src/e2e/runner.ts`、`packages/backend/src/tests/e2e/run-local.ts`、`docs/testing.md`。

## 6. Agent / Prompt：区分装配正确与效果达标

Grain 的 `.github/workflows/standard-eval-quick-gate.yml` 在相关 Agent / Eval 文件变化时运行 `--dry-run --dataset quick/v0`：它验证数据集加载、配置和评估 schema 可以完成装配，**不调用真实模型，也不构成“Agent 能力已经达标”的证据**。

真实效果验证另外通过受控环境的 quick / formal eval 或实际对话链路进行。评审时看用户是否能触发到被改行为：能触发的用户可见变化需要对应端到端验证，而不能因改动位于后端文件就跳过。模型输出不宜用逐字快照作硬门禁；更稳定的硬断言是授权、工具选择范围、状态、产物结构、不重复副作用和预算，内容质量再用固定任务集、趋势和人工复核判断。

对 DeepAuto 来说，这形成两条不能混用的证据：

1. **确定性硬门**：测试/构建/类型/权限/幂等/副作用/协议是否符合合同；失败即不能合并。
2. **概率性质量评估**：代码任务完成率、工具调用质量、回答质量、成本与耗时；用任务集和人工复核比较版本，不把一次随机输出当作全部质量结论。

参考来源：Grain `.github/workflows/standard-eval-quick-gate.yml`、`docs/testing.md`、`.github/prompts/claude-code-review.md`。

## 7. 评审、合并和事后监测

Grain 的评审 workflow 使用实际 CI 和 Preview 的结果，而不让模型“凭印象”宣布通过。评审说明要求读取等待脚本写出的当前提交状态；CI 失败或 Preview E2E 未通过时不能给普通 pass；基础设施故障需要标明归因，不能修改无关代码或调低测试阈值来制造绿色。代码通过后由负责人决定合并，评审 Agent 本身不是确定性测试的替代品。

PR 验证的时间点并不是终点：两个各自通过的 PR 合并后仍可能冲突。Grain 在 `dev`、`main` 的 push 上重新运行 CI，合并后红了由独立通知 job 发告警。另有单独的文档健康检查，对 PR 和主分支 push 检查相对链接与文档索引等一致性。

本文只说明仓库可观察到的 workflow 行为；远端 GitHub ruleset、分支保护中具体哪些 check 必需，仍需在有仓库管理权限时另行核对。**CI 自动运行和禁止绕过红灯合并是两件不同的配置。**

参考来源：Grain `.github/prompts/claude-code-review.md`、`.github/scripts/wait-non-review-ci.sh`、`.github/workflows/claude-code-review.yml`、`.github/workflows/ci.yml`、`.github/workflows/doc-lint.yml`。

## 8. DeepAuto 当前的实际缺口

截至本文核对时，DeepAuto 有 Bun、Turbo、Biome、TypeScript、PostgreSQL、Redis 和 workspace 清单，但 `apps/*`、`packages/*` 还没有实现文件；各包也没有 `test`、`typecheck`、`build`、`lint` 的实际脚本，没有测试文件或 GitHub Actions workflow。

本地实测根脚本：

| 命令 | 实际结果 | 风险 |
| --- | --- | --- |
| `bun run test` | 退出码 0，Turbo 提示 `No tasks were executed` | 没有测试仍显示成功 |
| `bun run typecheck` | 退出码 0，执行 0 个 task | 没检查任何业务 TypeScript |
| `bun run build` | 退出码 0，执行 0 个 task | 没验证运行产物 |
| `bun run lint` | Turbo 0 个 task；Biome 检查现有的 12 个配置/清单文件并成功 | 后续业务代码如不接入 package 脚本，门禁可能继续缺位 |

这不是当前代码“没有 bug”的证明，只说明**验证链路尚未搭建**。最先要排除的风险是“空跑也绿”，而不是追求一套复杂的缓存或高覆盖率报表。

参考来源：DeepAuto 根 `package.json`、`turbo.json`、各 workspace `package.json`，以及 2026-10-19 的本地命令结果。

## 9. 建议复用顺序与验收线

下面是基于 Grain 经验对 DeepAuto 的**建议**，不是 Grain 现成文件的复制清单：

| 次序 | 先建立什么 | 可以认为搭好了的条件 |
| --- | --- | --- |
| 1 | 无空跑的基础脚本与 CI | 各有源码的包确实运行类型检查、构建、Lint 和测试；零任务/漏掉预期测试时失败；故意引入类型错误、Lint 错误和失败断言时 CI 分别变红 |
| 2 | 关键合同单测 | 来源事件校验、权限拒绝、Job 状态机、conversation key、取消 attempt、凭证范围和副作用重试边界均有正反例 |
| 3 | PostgreSQL / Redis 集成测试 | 用隔离数据验证事件去重唯一约束、入队与状态持久化、同会话串行、Worker 崩溃/重复投递恢复；不能只依赖内存 mock |
| 4 | Harness 协议测试 | 用假 CLI 覆盖成功、超时、取消、重复 callback、部分产物、密钥泄露检查；独立测试仓库跑真实代码任务冒烟 |
| 5 | PR 与合并后门禁 | PR 自动跑确定性检查，项目管理员明确设置必需检查和人工合并策略；合并后继续运行，失败能通知到人 |
| 6 | 模型评测 | 固定任务集、版本对照、成本和质量报告独立于硬 CI；真实模型实验不以一次采样决定代码是否能合并 |

**验收第一步时请做故障注入**：让一个测试故意失败、把一个类型改错、引入一个违反规则的调用，再确认本地命令与 GitHub Actions 都真实失败；恢复改动后才重新变绿。没有这个反向验证，绿色图标没有证明力。

后续写 Gateway、Worker、Runner 的每一项功能，先明确它的不可逆动作、权限边界和外部状态，按对应层补测试；不为单纯转发与样式变化堆大量脆弱断言，也不因为模型输出非确定性就放弃对系统行为作确定性验证。
