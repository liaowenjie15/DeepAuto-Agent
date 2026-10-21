# B7：建立执行能力与依赖登记

## 目的

让 workflow、Prompt、工具白名单、callback、验证命令和权限之间的关系可验证，避免多执行器扩展后出现静默断链。

## 价值与意义

- 新增能力时能明确它由哪个 Executor 执行、调用哪些受控工具、要求什么验证和回调。
- 避免把 Grain 大量 workflow/Prompt/脚本的隐式依赖复杂度复制进 DeepAuto。
- 为权限审计、回归测试和能力下线提供单一清单。

## 前置条件

- 已稳定定义 capability、executor、workspace、验证目标和 callback 事件的基本数据结构。
- 控制面有可加载的 capability registry 或等效配置层。

## 实现方案

1. 每项执行能力登记：名称、允许入口、仓库 allowlist、Executor、工具白名单、最大时长、写入策略、验证目标、callback schema 与所有者。
2. 在 Dispatcher 启动前验证 registry；不允许 workflow 输入临时指定未登记的工具或仓库。
3. 为 registry 写测试：每个登记 workflow/Prompt/验证目标都存在，每个高风险能力都有安全审查规则。
4. 变更 registry 必须与对应 workflow、Prompt 或服务端适配器同一 PR 审查。

## 验收策略

- 未登记 capability、工具、仓库或 callback 类型被拒绝。
- 重命名 workflow/Prompt/验证脚本会被测试发现。
- 审计记录可从 Execution 反查到当次 capability 版本与策略快照。

## 人工决策

- registry 存放于代码、数据库还是两者结合；建议代码定义策略、数据库记录执行快照。
- capability 变更的审批级别及是否需要安全 reviewer。

## 非目标

不把 registry 发展成通用业务编排语言；目标是约束执行边界，不是创造新的 DSL。
