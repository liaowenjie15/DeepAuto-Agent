# D7：不复用 Grain 部署、Preview 与 SSH 编排

## 决策

不迁移 Grain 的 SSH/PM2 部署、Vercel alias、Testing/Stashing 环境、EAS 发布、FFmpeg Runner 或预览清理脚本。

## 目的

避免将 Grain 基础设施细节、长期 SSH 私钥和环境拓扑误带入 DeepAuto。

## 价值与意义

- DeepAuto 可根据自身部署平台选择 OIDC、短期云身份和隔离 Preview，而非继承历史服务器运维模式。
- 不让通用 Agent 平台负责与其产品无关的部署责任。
- 降低生产密钥、环境漂移和清理失败的攻击/运维面。

## 前置条件

无。DeepAuto 需要自身部署自动化时，另行定义环境、身份、发布、回滚、Preview 数据隔离和责任人。

## 执行与约束方案

1. 禁止复制 Grain 的 SSH Secret、域名、PM2 命令、Vercel 项目 ID 和清理逻辑。
2. 若未来引入部署，优先选择无常驻 SSH 私钥的短期身份方案。
3. 将应用部署与 DeepAuto Agent 的代码执行权限分离，不能因能提交 PR 就能发布生产。

## 验收策略

- DeepAuto workflow 不含 Grain 的主机、域名、部署命令或 Secret 名称。
- 新部署设计可解释身份来源、最小权限、回滚和 Preview 数据隔离。

## 人工决策

DeepAuto 自身的部署目标、云平台和发布责任模型；在此之前不创建“临时复用”的部署脚本。
