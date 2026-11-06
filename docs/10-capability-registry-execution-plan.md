# Capability Registry 执行计划

## 目标

为 DeepAuto 的 GitHub Actions 执行建立代码定义、可在启动时校验的 capability registry。Registry 是执行边界的单一来源：Dispatcher 只能选择已登记能力，Worker 只能从登记项获取 Executor、仓库、workflow、时限和 callback 合约；每次 Execution 都保存当时的 capability 策略快照，供审计和排障使用。

本计划只参考 Grain Niuma 的受控触发、显式权限、并发与超时模式；不复用 Grain 的内容生产、频道、Prompt profile、业务工具或 workflow 体系。

## 实施基线

- 代码基线：`feat/structured-execution-results`（B6）。它已提供结构化结果、callback 合约和 Execution bootstrap 安全绑定。
- 策略来源：代码内静态 registry。
- 审计来源：数据库内不可变 capability 名称、版本、策略 hash 与策略快照。
- 非目标：将 registry 发展为工作流编排语言，或允许调用方动态传入 workflow、仓库、工具和验证命令。

## 首期 Capability

首期只登记一个已具备真实执行基础的写入能力：

| 字段 | 值 |
| --- | --- |
| `id` | `repository.change-pr.v1` |
| Executor | `github-actions-codex` |
| Workflow | `.github/workflows/deepauto-execute.yml` |
| Workflow ref | `main` |
| 写入策略 | 仅新分支与 Pull Request；禁止默认分支写入、自动合并与部署 |
| 工具 profile | `codex-repository-change-pr` |
| Sandbox | `workspace-write`；禁止额外可写目录、用户配置与会话持久化 |
| Callback | 当前结构化 Execution result callback schema |
| 验证 | 项目验证入口与 capability 专属静态一致性检查 |
| 风险级别 | `high`；变更必须由安全 reviewer 审查 |

`execution.status` 与 `execution.cancel` 保留为 Gateway 控制面授权能力，不登记为 Runner capability。`repository.inspect`、`repository.verify` 与 `repository.review` 在拥有独立的只读 workflow、最小 token 和执行边界前不得启用。

## 实现步骤

1. 在共享代码中定义 capability schema、稳定版本、策略序列化和 hash，并建立首期 registry。
2. 为 registry 编写静态校验：唯一 ID、允许入口、仓库 allowlist、workflow/Prompt/验证目标存在性、callback schema、写入策略和高风险审查字段。
3. 在 Gateway 启动时加载 registry；Dispatcher 由受控服务端映射选择 capability，拒绝未登记能力及其仓库、工具、callback 类型。
4. Worker 只读取 Job 持久化的 capability snapshot，并在创建 Attempt 前同时验证 Job repository ID、当前 `WorkspaceRepository` allowlist 和 GitHub Actions Executor 的 provider repository ID；任一缺失或不一致均拒绝，不创建外部执行。
5. 增加数据库 migration 与 Execution 写入逻辑，持久化 capability ID、版本、policy hash 和 JSON 策略快照；一次性 bootstrap capability 仍只用于 OIDC 启动绑定。
6. 让 callback、对账、取消和审计读取保存的快照，而非重新解释当前 registry。
7. 增加单元、集成与静态资产测试，覆盖拒绝路径、快照稳定性和重命名资产检测。
8. 将 `verify:capabilities` 加入根脚本与 `.github/workflows/validate.yml`，使 PR 和 `main` push 都阻断无效 registry。

## CI 与仓库配置

代码库必须包含：

- `verify:capabilities`：运行 registry 静态校验，不连接外部服务；
- capability 单元测试：测试解析、拒绝、hash 与安全策略；
- 资产一致性测试：workflow、Prompt、验证目标重命名或删除时失败；
- PR 差异规则：registry 或高风险执行资产变更必须触发 capability 校验。

GitHub 仓库管理员还必须配置：

1. 将 registry、执行 workflow、Gateway/Worker 适配器路径纳入同一 `CODEOWNERS` 规则；
2. 对默认分支 ruleset 启用 Code Owner 审批、至少一名 reviewer 审批和必需状态检查；
3. 将 capability 校验 job 设为必需，禁止管理员绕过；
4. 保持 PR-only 交付：禁止默认分支写入、自动合并和自动部署。

CI 只能校验静态策略和必需检查；Code Owner 身份、ruleset 审批与绕过限制属于仓库管理员配置，不能由测试伪造。

## 上线顺序

1. 应用包含 Invocation、Job 和 Execution capability 字段的数据库 migration。
2. 在部署新 Worker 前暂停入队并清空或显式取消现有 QUEUED Job；旧 Job 没有 capability snapshot 或 repository ID 时会被 Worker fail-closed 拒绝，不会重新解释当前 registry。
3. 部署 Gateway，由 Dispatcher 创建带 capability snapshot 和 repository ID 的新 Job。
4. 为每个 Worker executor 配置受权威管理的 GitHub provider repository ID，并确认它与目标 `WorkspaceRepository.providerRepositoryId` 完全一致；`owner/repository` 名称不能替代该 ID。
5. 部署 Worker，使用持久化 Job snapshot 和上述三方仓库绑定执行；仅在 smoke test 确认 PR-only 交付、OIDC callback 与审计记录后恢复入队。

## 工具边界

Registry 中的 `toolProfile` 不是安全声明的替代品。首期 profile 将 Codex 强制为 `workspace-write` sandbox、忽略用户配置、使用临时会话且禁止额外可写目录；不允许用户输入临时 shell 工具、仓库或 workflow。它不等同于网络命令 allowlist，因此 capability 名称不宣称实现了通用 shell 工具白名单。

## 验收标准

- 未登记 capability、仓库、工具 profile 或 callback schema 在 Dispatcher/Worker 边界被拒绝。
- Execution 可审计地反查 capability ID、版本、hash 与完整策略快照。
- 重命名登记的 workflow、Prompt 或验证目标会使 capability 校验失败。
- 高风险 capability 缺少安全审查字段或违反 PR-only 写入策略会使校验失败。
- callback、取消和对账基于 Execution 快照继续工作，即使未来 registry 更新。
- 不引入默认分支写入、自动合并、部署或不受控外部执行入口。
