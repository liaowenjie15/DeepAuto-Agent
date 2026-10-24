# B4：改造 Agent Prompt 的分层与按需加载

## 实施状态

**进行中。** `feat/prompt-layering` 已以 `origin/main` 为基线创建独立工作树。实现采用仓库根 `AGENTS.md` 作为唯一全局规则层，并以 `.github/`、Gateway、Worker、DB、GitHub、Runner Manager 与飞书目录的嵌套 `AGENTS.md` 提供按路径/能力加载的细则；规则清单与版本集中在 `.deepauto/prompt-layers.json`。全局层把授权/审计/最小副作用/敏感信息/PR-only 作为硬边界，能力层只描述本模块的真源和安全约束，不复制 Grain 的频道、内容生产或组织约定。

受管执行 workflow 会把清单安全复制到 Runner 状态目录，并在 callback 前发送 `prompt_layers` artifact，因此每次 Execution 都能保留当时可用规则来源和版本；该 artifact 已加入共享事件契约，并由 workflow-boundary 检查约束。运行时 Prompt 仅说明使用全局层及与修改路径匹配的单一细则，不内联全部规则。当前实现和新增契约用例尚未运行测试、lint、typecheck、build 或 Hosted Runner 验证。

## 目的

采用“核心规则 + 能力/路径级细则”的 Prompt 组织方式，让每次执行获得最小但充分的安全上下文。

## 价值与意义

- 减少超长 system prompt 带来的上下文噪音、规则冲突和维护成本。
- 高风险操作能加载精确约束：GitHub callback、飞书资源、工作区隔离、凭证领取和 PR 交付。
- 让 Prompt 审查有明确落点，而不是在单一大文件里搜索隐含行为。

## 前置条件

- 明确哪些不变量适用于所有 Agent：授权、审计、最小副作用、敏感信息、PR-only。
- Hook 或 runtime 能按路径/能力安全地注入补充规则，且不会读取 `.env` 或调用网络。
- 各能力有稳定的命名和所有者。

## 实现方案

1. 建立小型全局规则文件，仅保留不变量与失败时的上报要求。
2. 为 Gateway、Worker、GitHub、Runner Manager、DB 和飞书能力建立按需规则。
3. Prompt 中只引用 DeepAuto 的领域实体和真源，不复制 Grain 的频道、内容生产、巡检和组织人员约定。
4. 为每次注入记录来源和版本，便于执行审计和 Prompt 回归。

## 验收策略

- 编辑不同高风险路径时只加载对应细则，且全局规则不重复膨胀。
- Prompt 不包含 token、真实用户数据或依赖易漂移的目录清单。
- 审查样例可证明 Agent 能识别越权合并、callback 重放和跨工作区写入。

## 人工决策

- Prompt 的权威目录及修改审批人。
- 哪些规则应当是硬阻断，哪些只作为审查/提示。

## 非目标

不追求一套对所有模型完全相同的长 Prompt；runtime 差异由适配层处理。
