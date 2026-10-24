# DeepAuto Agent：Codex 项目级配置设计与实施方案

> 状态：**设计完成，待实施**
>
> 编写日期：2026-10-21
>
> 适用范围：DeepAuto 仓库中的 Codex CLI 会话、子 Agent 委派与本地开发流程；不改变 DeepAuto 的业务运行面。
>
> 相关文档：[统一 Agent 平台架构](./03-unified-agent-architecture.md) · [CLI Runtime 与 GitHub Actions Harness 架构决策](./05-cli-runtime-github-actions-harness-architecture.md) · [测试与验证机制实施方案](./07-testing-validation-implementation-plan.md) · [受控试运行与首个真实任务闭环](./pending-tasks/02-controlled-pilot-rollout.md)

## 1. 目标与边界

在 DeepAuto 仓库根目录建立 `.codex/`，为在该仓库工作的 Codex 提供**项目级补充行为**：按改动加载必要上下文、在交付前提示高风险边界、提供针对 DeepAuto 的审查角色，并隔离会话缓存。

它不是 DeepAuto 的 Gateway、Worker、Runner 或凭证管理系统，也不能替代 CI、数据库约束、鉴权、分支保护或人工审批。Hook 产生的是提示与上下文；真正的安全边界仍须由代码和远端平台执行。

首期必须遵守：

- 不在 `.codex/` 保存 GitHub、OpenAI、飞书、OIDC、数据库或任何长期凭证。
- 不让 Hook 自动 `git commit`、`git push`、创建 Pull Request、部署服务或修改远端平台配置。
- 不复制 Grain 的业务术语、MCP 地址、Skill 架构、前端技术栈假设或目录约定。
- 测试验证工作当前暂停：初期 Agent 只报告“未运行的验证”，不擅自执行大范围测试，也不把未验证写成通过。
- `.codex/tmp/` 仅存会话级去重状态，必须被 Git 忽略。

## 2. 从 Grain 提取的能力

Grain 的 `.codex/` 提供了四类能力，其中只有一部分适合迁移。

| Grain 能力 | 处理方式 | DeepAuto 中的用途或原因 |
| --- | --- | --- |
| 会话启动与工具调用后的规则提醒 | **改造后迁移** | DeepAuto 尚无 `.claude/rules/` 体系，不能原样复制；应改为按目录提示最少的架构与安全文档。 |
| `git push` / `gh pr create` 前的根因自检 | **改造后迁移** | 通用价值高，但必须改为 DeepAuto 的 webhook、OIDC、队列、凭证与 PR-only 交付边界。 |
| 提交前代码审查子 Agent | **改造后迁移** | 保留“只审 diff、分阻塞/建议、给出修复方案”的方法，删除 Grain 的 tRPC、Tailwind、频道与容器专属假设。 |
| 会话临时缓存 | **迁移** | 用于避免同一会话重复注入相同上下文；不得提交。 |
| `grain_pm` MCP | **不迁移** | 地址、身份和产品管理模型均属于 Grain；DeepAuto 未定义等价的数据源与授权方式。 |
| i18n 翻译 Agent | **暂不迁移** | DeepAuto 当前没有对应的多语言 catalog 与翻译 CLI 约定；复制会产生失效路径和错误提交行为。 |
| Skill 影响评估 Agent | **暂不迁移** | 它服务 Grain 的 Prompt/Capability/In-house Skill 分层，DeepAuto 当前不具备同构对象。 |
| E2E `BLOCKED` 评论提醒 | **暂不迁移** | DeepAuto 没有同名视觉 E2E 工作流；通用化前会制造无效提醒。 |

## 3. DeepAuto 的首期目录设计

建议首期只建立以下最小集合：

```text
.codex/
  config.toml
  agents/
    code-reviewer.toml
    execution-safety-reviewer.toml
  hooks/
    deepauto-context-reminder.ts
    delivery-safety-reminder.ts
  tmp/                         # Git 忽略，由 Hook 按需创建
```

不创建通用的远端 MCP 配置，不创建自动翻译、自动提交或自动部署脚本。每个 Hook 都应使用仓库根目录的相对路径，并在不处于 Git 仓库、输入缺失或文档不存在时安静退出。

## 4. Hook 设计

### 4.1 `deepauto-context-reminder.ts`

在会话启动、恢复及文件编辑后运行。它根据本次工具输入中涉及的路径，最多提示一到两篇 DeepAuto 文档；只补充当前任务需要的约束，不复制整篇架构文档。

建议的映射：

| 触及路径 | 提示的重点 |
| --- | --- |
| `apps/gateway/**` | webhook 验签、入口标准化、成员映射、仓库 allowlist、OIDC 回调边界。 |
| `apps/worker/**`、`packages/runner-manager/**` | Job/Attempt/Execution 状态、会话锁、超时/取消、隔离 Runner 与 PR-only 交付。 |
| `packages/github/**` | GitHub App 最小权限、installation token、workflow dispatch、OIDC claim 校验。 |
| `packages/db/**`、`tests/integration/**` | PostgreSQL 为真源、幂等、事务、outbox、真实 PostgreSQL/Redis 集成边界。 |
| `docs/**` | 保持架构决策、运行不变量和排查入口；不把易漂移的目录树或命令清单复制进文档。 |

该 Hook 的输出只应包含尚未注入过的规则，并以会话 ID 的哈希作为缓存键。它不得运行测试、读取 `.env`、调用网络或推断凭证。

### 4.2 `delivery-safety-reminder.ts`

仅在 Bash 命令疑似包含 `git push` 或 `gh pr create` 时提示。提示应要求 Codex 检查：

1. 改动是否从根因修复，而非吞异常、放宽鉴权、绕过签名验证或用默认值掩盖失败；
2. 是否改变了 GitHub webhook、OIDC、Codex 代理、凭证 claim、队列、状态机或外部写入边界；
3. 是否泄露了 token、callback claim、私钥、数据库连接串或上游 API key；
4. 成功任务是否仍只通过非默认分支的 Pull Request 交付，且没有引入自动合并或自动部署；
5. 当前测试暂停时，PR 描述是否如实说明哪些验证尚未运行。

它只能提示，不能把解析 Bash 字符串当作安全控制。GitHub 分支保护、工作流权限和服务端鉴权才是实际拦截点。

## 5. 子 Agent 设计

### 5.1 `code-reviewer`

保留 Grain 中独立审查的优点，但将审查上下文改为 DeepAuto：

- 只审查 `git diff` 与 `git diff --cached`；
- 把签名验收、身份/工作区隔离、仓库 allowlist、状态转换、幂等、取消竞争、回调防重放和凭证边界列为阻塞级检查；
- 检查外部写入是否仍经分支和 Pull Request，而非默认分支直写；
- 检查日志、审计 metadata、workflow input 和环境变量中是否出现敏感值；
- 区分“必须修复”和“改进建议”，每个阻塞项必须给出可操作的修复方向；
- 不硬编码 Grain 的技术栈、前端目录、容器实现或业务术语。

### 5.2 `execution-safety-reviewer`

只在修改以下区域且准备交付时委派：`apps/gateway/`、`apps/worker/`、`packages/github/`、`packages/runner-manager/`、`packages/db/` 和 GitHub workflow。

它专门检查控制面与运行面边界：可信调用者、短期凭证、OIDC claim、Execution 绑定、回调重放、超时/取消、会话锁释放、产物可信度和 GitHub Actions 权限。它不替代通用代码审查，也不自动批准远端部署。

## 6. 配置与缓存约定

`config.toml` 应只声明：启用 Hook、各 Hook 的触发时机、最多十秒的超时和本地 Agent 定义。所有命令使用 Bun 执行，失败时只输出诊断，不中断无关的开发工作。

`.gitignore` 应加入：

```gitignore
/.codex/tmp/
```

仓库应提交 `config.toml`、Hook 源码和 Agent 定义；不提交临时缓存、macOS `._*` 文件、token、`.env` 或任何本机密钥存储。

## 7. 实施顺序

1. 建立 `.codex/`、忽略临时目录，并添加最小 `config.toml`；不接入 MCP。
2. 实现 `deepauto-context-reminder.ts`，先覆盖 Gateway、Worker、GitHub、Runner、DB 和文档六类路径。
3. 实现只提示、不执行远端操作的 `delivery-safety-reminder.ts`。
4. 添加并人工校对 `code-reviewer` 与 `execution-safety-reviewer` 的角色定义。
5. 使用一个本地 Codex 会话验证：启动时只出现必要提示；编辑不同目录时只增加对应上下文；`tmp/` 不进入 Git 变更。
6. 在测试验证恢复后，再决定是否增加针对测试命令、失败输出和 E2E 结果的专用规则；不得把暂停期的临时策略固化为长期门禁。

## 8. 验收标准

- DeepAuto 中的 Codex 会话能获得与当前改动相关的最小上下文，不会反复灌入无关文档。
- Hook 不读取或输出 `.env`、token、私钥、OAuth refresh token、callback claim 或数据库连接值。
- Hook 不创建提交、PR、部署、远端变量、仓库 secret 或 GitHub App 配置。
- 审查 Agent 的阻塞项能覆盖 DeepAuto 特有的授权、状态机、执行隔离和外部副作用边界。
- `.codex/tmp/` 和 macOS `._*` 文件不被提交。
- 当项目没有触及高风险路径时，配置不会制造与任务无关的审查、测试或部署噪音。

## 9. 后续决策

只有在 DeepAuto 明确引入对应能力后，才评估新增：项目管理 MCP、国际化 Agent、视觉 E2E 提醒、发布/部署提示或更多专用审查角色。每增加一项都必须先定义可信数据源、权限边界、失败行为和可验证的收益，不能因为 Grain 已有同名能力而直接复制。
