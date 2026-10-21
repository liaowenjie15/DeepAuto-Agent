# D2：不复用 Grain Niuma Runtime Harness 实现

## 决策

不直接依赖或复制 `niuma-harness`、其多 CLI runtime 适配层、模型路由参数、缓存目录和运行时交接协议。

## 目的

保持 DeepAuto 的 `ExecutorAdapter`、凭证领取、工具白名单、成本预算和审计由自身控制面掌握。

## 价值与意义

- 避免 DeepAuto 的产品边界、版本节奏和安全模型被 Grain 的私有执行实现绑定。
- 允许 DeepAuto 选择最适合自己的 Codex/CLI/Local Sandbox 路径。
- 降低跨仓库供应链、凭据格式和 session 语义不一致的风险。

## 前置条件

无迁移前置条件。若需支持多个 runtime，应先完成 DeepAuto ExecutorAdapter 的稳定接口与测试。

## 执行与约束方案

1. 只吸收其原则：runtime 可插拔、事件标准化、短期凭证、失败可交接。
2. 每个 DeepAuto runtime adapter 单独定义启动、取消、结果归一与安全边界。
3. 禁止让 runtime adapter 决定用户授权、最终任务状态或自动合并。

## 验收策略

- DeepAuto 新增或移除 runtime 时不需要改变 Job/Attempt 的业务语义。
- 不存在对 Grain Action、Grain Secret 或 Grain 缓存目录的运行时依赖。

## 人工决策

何时引入第二个 runtime；在首个 GitHub Actions Executor 稳定前不讨论多 runtime。
