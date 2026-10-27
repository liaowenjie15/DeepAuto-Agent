# Capability Registry V1 策略决策

## 目的

确定 DeepAuto B7 capability registry 的首期能力范围、冻结时点、仓库模型、执行隔离、审查门禁、预算与审计策略。本文是后续实现与仓库配置的决策基线。

## V1 决策

| 项目 | 决策 | 说明 |
| --- | --- | --- |
| 首批能力 | 仅启用 `repository.change-pr.v1` | 当前唯一具备 OIDC、callback 与 PR-only 交付链路的能力。`inspect`、`verify`、`review` 需拥有独立只读 workflow 后才可启用。 |
| 策略冻结 | Dispatcher 入队即冻结 | Job 保存 capability ID、版本、policy hash 与完整快照；Worker 和 Execution 只能继承快照，不重新解释当前 registry。 |
| 仓库模型 | 每个 Workspace 可以管理多个仓库 | V1 对每个仓库固定使用 `deepauto-execute.yml@main`；每个仓库必须有 provider repository ID、GitHub App 安装记录与 WorkspaceRepository allowlist。 |
| 工具与网络 | Codex 仅工作区可写 | 禁止用户配置、会话持久化与额外可写目录。后续 Runner 必须将 Codex 网络出口限制为模型代理与 Gateway。 |
| Prompt 管理 | 仓库文件定义，Execution 保存 hash | Prompt 是受评审的代码资产；数据库只保存版本、hash 与当次快照，不允许运行时数据库修改执行策略。 |
| 审批责任 | 高风险变更需要 Code Owner 与第二名维护者 | `@liaowenjie15` 仅为过渡 owner；生产前改为至少两名成员的可见安全团队。 |
| 运行预算 | 15 分钟硬超时；每 Workspace 同时 1 个、全局同时 2 个 | 仅保留 GitHub API 基础设施重试；已开始的代码任务不得自动重跑。模型代理具备权威计量前，不配置虚假的成本预算。 |
| 日志与审计 | 审计事实保留 365 天 | 保存策略快照、授权决策、状态转换与安全摘要；原始模型/Runner 日志默认不写入 DeepAuto 数据库，完整审计仅安全管理员可读。 |

## 必须补齐的实现

1. 已实现：Dispatcher 创建 Job 时写入 capability snapshot，Worker/Execution 只继承该 snapshot。
2. 已实现：执行前校验 Job repository ID、WorkspaceRepository provider ID 与 GitHub Actions executor 配置的 provider repository ID 完全一致。
3. 将 Codex 进程放入只允许模型代理和 Gateway 出网的 Runner 环境；Codex 运行期间不提供 GitHub、部署或云凭据。
4. 为 capability 创建稳定 Prompt 资产，registry 引用其路径/版本，CI 验证其存在性，Execution 保存内容 hash。
5. 增加 Dispatcher、Worker 与数据库集成测试，覆盖未登记 capability、仓库不匹配、旧 Job snapshot 与 callback schema 不匹配。

## 必须完成的仓库与运维配置

1. 将 capability registry、workflow、Dispatcher、Worker、数据库 migration 与边界检查脚本的 `CODEOWNERS` 合入 `main`。
2. 对 `main` Ruleset 要求 `actionlint`、`workflow-boundary` 与 `validate` 检查通过，并要求 Code Owner 审批。
3. 指定第二位维护者，或创建至少两位成员的可见 GitHub 安全团队，替换过渡期个人 owner。
4. 为每个启用仓库登记 GitHub App 安装、provider repository ID、WorkspaceRepository、OIDC trust policy 与 Actions `DEEPAUTO_GATEWAY_URL`。
5. 在模型代理支持权威成本计量后，设置每次执行的硬预算；在此之前保持低并发 pilot。

## 日志与审计边界

- Execution 策略快照、授权决策、状态转换和安全摘要保留 365 天。
- 原始模型/Runner 日志默认不写入 DeepAuto 数据库，避免凭据或敏感材料扩大留存面。
- 审计详情仅安全管理员可读；成员只能查看自身任务的安全摘要。
- 保留期届满后按自动清理流程删除，存在法律保全要求时暂停删除。
- 若适用中国网络运营者日志留存要求，相关网络日志的保存期限不得低于六个月；本策略的 365 天审计保留高于该最低期限。

## 下一项实现

按 `docs/10-capability-registry-execution-plan.md` 的上线顺序执行 migration、清理旧的排队 Job，并为 Worker 提供权威 GitHub provider repository ID。完成后再开始网络出口隔离与稳定 Prompt 资产两项工作。

## 参考

- [《中华人民共和国网络安全法》第二十一条](https://www.cac.gov.cn/2016-11/07/c_1119867116_2.htm)
