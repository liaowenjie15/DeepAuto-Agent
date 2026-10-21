# D1：不复用 Grain 内容与运营 Workflow

## 决策

不迁移 Grain 的视频、SEO、性能、慢 SQL、支付、Affiliate、外联、Warmup、Smartlead、用户表、Landing/Onboarding 等业务 workflow、Prompt、脚本与 Secret 命名。

## 目的

阻止“现成 workflow 看起来可用”成为把 Grain 业务数据模型带入 DeepAuto 的理由。

## 价值与意义

- 保持 DeepAuto 是通用 Agent 平台，而不是内容运营系统的复制品。
- 避免引入无法验证的数据表、Vercel 项目、人员通知、营销 API 与合规责任。
- 降低 64 条 workflow 带来的维护复杂度和凭据暴露面。

## 前置条件

无功能前置条件；这是架构边界。若未来出现同名业务需求，必须先定义 DeepAuto 自己的数据模型、授权、SLA 和责任人。

## 执行与约束方案

1. 新增 workflow 前检查其是否依赖 Grain 专属概念、表结构、域名、人员或 Secret。
2. 命中时禁止复制；需求方改写为 DeepAuto 的业务目标、数据源和最小能力。
3. 评审中发现 Grain 文件被直接复制时，要求删除并重新设计。

## 验收策略

- DeepAuto `.github/`、Prompt 和环境变量中不存在 Grain 业务专属名称或 endpoint。
- 每个新增定时 workflow 都能说明其 DeepAuto 数据源、用户价值和 owner。

## 人工决策

无。未来业务需求不是本决策的例外，而是新需求的独立立项。
