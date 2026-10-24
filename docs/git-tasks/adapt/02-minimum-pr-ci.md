# B2：改造为 DeepAuto 最小 PR CI

## 实施状态

**已实现，仍处于 required-checks 观察期。** `validate.yml` 已在 Pull Request 与 `main` push 上以只读权限执行 `bun install --frozen-lockfile`、Prisma generate、`verify:targets`、`lint`、`typecheck`、`build` 与 `test:unit`；同一 job 还在隔离的 PostgreSQL/Redis service 中执行 `test:integration`。`actionlint` 与 `workflow-boundary` 保持独立、稳定的只读 check。

截至 2026-10-24，PR #12、#13、#14 及其合并后的 `main` push 已连续产生 6 次成功的 `validate` 运行；早期失败是功能实现缺陷修复前的有效失败，不能计入稳定性样本。尚未达到建议的连续一周或至少 10 次有效 PR 运行阈值，且当前没有可读取或已配置的 `main` required-checks 规则。因此下一步是继续观察并在阈值满足后由仓库管理员显式配置 required checks；不在本任务中自动修改分支保护。

## 目的

以 Grain 的“快速、确定性、分层验证”原则，为 DeepAuto 建立 PR 级 `lint`、`typecheck` 和单元测试门禁。

## 价值与意义

- 为人类和 Agent 创建的 PR 提供可复现的基础正确性证据。
- 将成本高、依赖真实基础设施的集成测试与每次 PR 的快速反馈分开。
- 使代码任务的完成标准不再只依赖 Agent 自述。

## 前置条件

- `bun install`、`lint`、`typecheck`、`test:unit` 已能在干净 Runner 稳定执行。
- `verify:targets` 与 Prisma generate 的依赖在 CI 中有明确顺序。
- 已确认缓存不会携带 token、数据库产物或未受信任 PR 内容。

## 实现方案

1. 新建只读 CI workflow，触发 PR 和受保护分支 push。
2. 按顺序运行依赖安装、`lint`、`typecheck`、`test:unit`；失败应直接给出可定位输出。
3. 集成测试保持显式入口，使用 `compose.test.yaml` 启动真实 PostgreSQL/Redis。
4. 先以非阻塞方式连续运行这些检查，确认命令、环境、缓存、稳定 check 名称和 fork 行为；再将其设为 required checks。
5. required checks 启用后，Agent 创建 PR 后必须等待这些检查，且不允许以“模型已确认”为由绕过。

## 验收策略

- 故意引入 lint、类型和单测错误，各自能独立失败。
- CI 不依赖 `.env.local`，不输出密钥，不申请写仓库权限。
- 同一提交在本地和 GitHub Runner 结果一致；集成测试失败能区分基础设施与业务失败。

## 人工决策

- 何时将 `actionlint`、`lint`、`typecheck`、`test:unit` 从观察期升级为 required checks；建议连续一周或至少 10 次有效 PR 运行无环境性/偶发失败后启用。
- 何时将集成测试升级为 PR 必跑，而不是手工或合并前触发。
- 是否允许 Agent 在所有 required checks 成功前继续更新 PR。

## 非目标

不复制 Grain 的多分支发布策略、Turbo 缓存细节或 Feishu 通知。
