# B1：改造 Niuma 的可靠 Agent 执行闭环

## 目的

将 Grain/Niuma 已验证的会话续跑、状态可见、取消、失败补发和回执能力，改造成 DeepAuto 的控制面能力。

## 价值与意义

- 用户连续追问、Runner 暂时故障或任务取消时，系统仍能给出可信进度与明确出口。
- 把“一次 CLI 调用”升级为可审计、可恢复的异步 Execution。
- 为 GitHub Actions 与 Local Sandbox 共用同一状态机，避免各执行器各自发明会话和重试逻辑。

## 前置条件

- 完成 `Invocation → Job → Attempt → Execution` 状态机及幂等键设计。
- Redis 锁、取消信号、回调认证和数据库事务边界可测试。
- 已定义 conversationKey、workspace、调用者与权限快照的关联约束。

## 实现方案

1. Dispatcher 为每次执行生成 Attempt 和任务绑定凭证，而不是把用户上下文直接塞给 workflow。
2. ExecutorAdapter 提供启动、查询、取消和 callback 标准化接口。
3. GitHub Actions 只报告标准事件；Gateway 校验后更新状态并向飞书/GitHub 回执。
4. 同一 conversation 的多个任务使用 FIFO 队列：新任务不取消正在运行的任务，前项进入终态后才允许下一项领取执行资源。
5. 重试按失败类别决定：临时基础设施错误可限次补发，权限/输入/策略错误直接终止并解释。
6. session resume 仅在同一 conversation、调用者、工作区和权限范围一致时允许。

## 验收策略

- 重复 Invocation 不会产生两个可写执行。
- 同一 conversation 的三项连续任务严格按入队顺序运行；前项失败或取消后，下一项仍能按策略启动。
- 取消、超时、Runner 失联、回调重放、恢复执行均有确定状态转换测试。
- 回执在来源 thread/Issue/PR 上更新，但其内容来自控制面已验证状态。

## 人工决策

- 各失败类别的重试次数、退避时间与是否允许自动恢复。
- 是否允许同一 conversation 的后续消息自动恢复之前 session；排队不等于默认恢复 session，两项必须独立决定。

## 非目标

不接入 Grain 的 Niuma Harness、模型路由语法、缓存目录或飞书组织特例。
