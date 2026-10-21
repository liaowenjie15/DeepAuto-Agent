# D3：不把 GitHub 事件当作控制面真源

## 决策

Issue、PR、评论、label、workflow run 只能作为入口或回执载体；它们不得成为 DeepAuto 的身份、授权、任务状态或会话真源。

## 目的

保护统一 Invocation、审计、幂等和多入口一致性设计。

## 价值与意义

- 飞书和 GitHub 能以同一任务模型进入系统，而不是各自拥有不兼容状态机。
- GitHub webhook 重投、编辑、删除、权限变化不会直接篡改 DeepAuto 业务记录。
- 数据库能解释完整历史，不依赖外部平台的可见性和保留规则。

## 前置条件

Gateway、数据库和 GitHub App webhook 验签是此边界的基础；它们必须优先完成。

## 执行与约束方案

1. 所有 GitHub 事件先验签、标准化为 Invocation，再进行授权和幂等检查。
2. GitHub 评论中的 command/marker 只引用控制面已有记录，不直接携带权限结论。
3. GitHub run 状态通过 callback 或轮询映射为 Execution 事件，不能直接覆盖 Job 终态。

## 验收策略

- webhook 重放、Issue 编辑、评论删除和 GitHub run rerun 不会产生重复或错误状态转换。
- 从数据库可还原一次任务的来源、授权快照、Attempt 和回执锚点。

## 人工决策

无；这是 [03-unified-agent-architecture.md](../../03-unified-agent-architecture.md) 已确定的基础边界。
