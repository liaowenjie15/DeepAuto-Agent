# B6：定义结构化执行结果与失败分级

## 目的

将 Runner 的原始日志和 CLI 输出转换为 Gateway 可验证、用户可理解、可审计的 Execution 终态事件。

## 价值与意义

- 不再依赖 GitHub Actions 页面或非结构化日志判断任务是否成功。
- 可为重试、人工介入、用户回执、成本统计和多执行器统一提供稳定接口。
- 控制敏感信息外泄：用户只看到安全摘要，原始材料按权限保留。

## 前置条件

- Execution/Attempt 状态机和 callback 身份校验已定义。
- 已确定日志保存位置、保留期限、访问控制和脱敏策略。
- 已列出可重试与不可重试失败类别。

## 实现方案

1. 定义 callback schema：`executionId`、`attemptId`、终态、失败类别、安全摘要、日志引用、可重试标识、产物引用与时间戳。
2. Gateway 校验签名、时效、Attempt 归属和状态转换后才落库。
3. 将日志细节与用户摘要分层存储；禁止 token、私钥、数据库 URL 和完整环境变量进入摘要。
4. 为 GitHub Actions 与 Local Sandbox 提供同一规范化适配器。

## 验收策略

- 成功、验证失败、策略拒绝、超时、取消、基础设施失败和 callback 重放均有 schema/状态机测试。
- 缺少必填字段、跨 Attempt 上报和过期回调被拒绝。
- 飞书或 GitHub 回执只出现安全摘要，不含敏感值。

## 人工决策

- 已确认失败类别：`VALIDATION_FAILED`、`POLICY_REJECTED`、`CANCELLED`、`TIMEOUT`、`INFRASTRUCTURE_FAILED`、`CALLBACK_REJECTED`。仅基础设施失败和超时自动重试，最多两次，使用指数退避。
- Gateway 仅持久化日志引用、期限和安全摘要；GitHub Actions 原始日志由 GitHub 保留，Local Sandbox 原始日志保留 30 天。
- 原始日志仅仓库维护者和指定安全负责人可访问，并要求审计记录；普通成员、任务发起者、外部贡献者和 Agent 仅可获得安全摘要。
- 测试结果采用独立结构化摘要，详细报告作为 artifact 引用保存。
- 安全摘要限制长度并拒绝 token、私钥、数据库 URL、完整环境变量和原始命令输出。

## 非目标

不在本任务中定义面向运营的数据分析或用户计费模型。
