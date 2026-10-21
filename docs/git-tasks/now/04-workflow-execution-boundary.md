# A4：固化“Workflow 只负责执行”的边界

## 目的

把 DeepAuto 已有的控制面/执行面分离落实为 workflow 评审规则：GitHub Actions 只能执行已授权的 Attempt，不能成为身份、权限、任务终态或长期凭证的真源。

## 价值与意义

- 防止随着功能增加，把授权判断、飞书用户 token、自动合并或最终状态写进 workflow shell。
- 保持 `ExecutorAdapter` 可替换性：未来加入 Local Sandbox 或新 CLI runtime 时，业务记录和审计不被 GitHub 锁定。
- 限制 Runner 被攻破时的影响范围。

## 前置条件

- Gateway 已验证 GitHub OIDC claim 并只签发任务绑定 bootstrap/session 材料。
- PostgreSQL 已作为 Job、Attempt、Execution 的业务真源。
- callback 端点可以认证 Runner 并校验 Execution 归属。

## 实现方案

1. 在 workflow 评审模板中加入边界检查：不得保存长期 token、不得自行判定用户权限、不得直接更新最终任务状态。
2. 所有执行输入必须含 `execution_id`，并由 Gateway 返回短期、最小化材料。
3. 对 Runner 回调采用签名、时效、Attempt 绑定和重放防护。
4. 仅允许任务分支、提交和 PR 交付；合并、生产部署和仓库设置修改保持独立流程。

## 验收策略

- 静态检查和代码审查能拒绝 workflow 中新增的长期 Secret 或直接数据库连接。
- Runner 的伪造 callback、过期 bootstrap 和跨 Execution 回调均被 Gateway 拒绝。
- 停用 GitHub Actions 后，控制面仍能完整解释历史 Job/Attempt/Execution。

## 人工决策

- 定义任务绑定凭证的最长有效期、刷新条件和审计保留周期。
- 明确哪些 GitHub 写操作允许由 Runner 的短期代理完成。

## 非目标

不在此任务中新增第二个执行器；重点是为后续执行器预留正确边界。
