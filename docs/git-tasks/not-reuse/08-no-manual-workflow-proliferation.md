# D8：禁止为每项运营活动增建手动 Workflow

## 决策

不复用 Grain 大量 `workflow_dispatch` 表单入口的组织模式。DeepAuto 保留一个由控制面派发的执行 workflow；新的运维操作优先进入受鉴权 API 或控制台。

## 目的

防止参数校验、权限检查、审计、输入协议和用户体验分散到几十份 GitHub YAML 表单。

## 价值与意义

- 所有入口统一走 Invocation、policy、审计和状态机。
- 减少 workflow 数量、Secret 引用和维护负担。
- 可向飞书、Web 控制台和 GitHub 提供一致能力，而不是让 GitHub 表单成为唯一后台。

## 前置条件

Gateway/Dispatcher 能安全接收受鉴权请求，并将其标准化为 Job/Execution。

## 执行与约束方案

1. 新需求先问能否作为现有 capability 的参数，由 Dispatcher 派发给现有 workflow。
2. 只有执行环境真实不同、权限边界不同或生命周期不同，才允许增加 workflow。
3. 新 workflow 必须说明为什么控制面 API/控制台不能承载，并通过 A2 安全基线审查。

## 验收策略

- 新增手动 workflow 有明确 executor 边界、独立权限原因和 owner。
- 用户/运营操作的审计记录均可在控制面查询，不依赖 GitHub dispatch 历史。

## 人工决策

什么时候提供 DeepAuto 内部控制台；在此之前可用受鉴权 API，但不能用散落 workflow 代替长期产品入口。
