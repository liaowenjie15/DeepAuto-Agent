# A3：固定 GitHub Action 供应链版本

## 目的

为 DeepAuto 的 `uses:` 依赖建立可审计、可回滚的版本策略，防止上游 tag 漂移在未审查情况下进入高权限 Runner。

## 价值与意义

- DeepAuto workflow 会领取 OIDC token、从 Gateway 获取任务材料、运行 CLI Agent；供应链变更属于执行面信任边界。
- 固定版本让一次失败可复现，也能明确安全修复何时被引入。
- Grain 的可变 tag/`@main` 用法说明这是必须主动避免的负债，而不是可复制的模式。

## 前置条件

- 列出所有现有和计划使用的 Action、维护方、许可证、权限和升级渠道。
- 确定允许的固定形式：推荐使用经过审查的完整 commit SHA，并保留可读的版本注释。

## 实现方案

1. 创建 Action 依赖清单，至少包含来源、SHA、原始 release、用途、使用 workflow 和审查人。
2. 将 `actions/checkout` 及后续第三方 Action 固定到 SHA。
3. 升级 Action 只能通过独立 PR；PR 同时说明 changelog、权限变化和回滚 SHA。
4. 对本仓库本地 Action 不适用 SHA 固定，但仍要求 code review 与路径级验证。

## 验收策略

- 搜索 `.github/**` 后，第三方 `uses:` 均为批准的不可变 SHA。
- Action 升级 PR 可追溯到依赖清单与审查记录。
- 固定后 `deepauto-execute.yml` 仍可成功 checkout 并完成 OIDC bootstrap。

## 人工决策

- 是否允许 GitHub 官方 Action 继续使用主版本 tag；安全默认是不允许。
- 由安全负责人还是平台负责人审批 Action 升级。

## 非目标

不把固定 SHA 误认为完整供应链安全方案；仍需定期升级并评估已知漏洞。
