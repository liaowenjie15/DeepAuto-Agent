# B5：实施双层代码审查模型

## 实施状态

**进行中。** 以 `origin/main`（已含 B4）创建 `feat/two-layer-code-review`。新增本地只读审查协议与 `bun run review:plan -- <base-ref>`：它只读取 Git diff 的路径，普通变更要求 `code-reviewer`，而 Gateway、Worker、GitHub、Runner Manager、DB 与 `.github/**` 改动额外要求 `execution-safety-reviewer`。计划输出不包含 diff、用户数据或配置内容。

已确定的治理规则：阻塞项仅可由仓库维护者或指定安全负责人以书面 PR 记录豁免；Agent 可修复后重复两层审查，最多两轮，仍有阻塞项必须人工接手。审查器不得批准合并、部署或执行远程操作，且不替代 lint/typecheck/unit test。

## 目的

在通用代码审查之外，增加仅针对 DeepAuto 控制面和执行边界的安全审查。

## 价值与意义

- 通用 review 擅长发现逻辑、类型和可维护性问题；专门 review 聚焦 webhook、OIDC、状态机、幂等、取消和凭证边界。
- 避免复制 Grain 的多模型云端审查矩阵，同时获得与 DeepAuto 风险匹配的第二视角。
- 让“是否可以交付 PR”有可解释的阻塞级判断。

## 前置条件

- 已定义 `code-reviewer` 与 `execution-safety-reviewer` 的职责边界。
- 高风险路径已登记：`apps/gateway/`、`apps/worker/`、`packages/github/`、`packages/runner-manager/`、`packages/db/`、`.github/**`。
- 基础 lint/typecheck/unit test 已存在，review 不替代确定性测试。

## 实现方案

1. 先作为本地 Codex 的独立审查角色运行，只读取 diff 和必要架构规则。
2. 高风险路径变更在准备 PR 时必须调用 execution-safety-reviewer。
3. 输出分为“阻塞修复”和“非阻塞建议”；阻塞项必须指出受影响边界、攻击/失败路径和修复方向。
4. 稳定后再评估是否把审查结果接入 PR 检查，禁止一开始就自动批准或自动合并。

## 验收策略

- 使用 webhook 签名绕过、跨 Execution callback、错误 OIDC audience、默认分支写入等缺陷样例验证审查质量。
- 普通 UI/文档变更不会被要求运行无关安全审查。
- 审查结果不泄露 diff 中的敏感配置或用户信息。

## 人工决策

- 哪些阻塞项必须由人类批准才能豁免。
- 是否允许 Agent 根据 review 自行修复后重复审查，以及最大循环次数。

## 非目标

不构建 Grain 风格的自动评审对战、评分或自动 rerun 网络。
