# D5：禁止跨仓库 Secret 同步

## 决策

不复用 Grain 的 `secret-sync.json`/`sync-secrets.yml` 模式，不让一个仓库向多个仓库复制长期 Secret。

## 目的

坚持 DeepAuto 的短期、任务绑定凭证与 GitHub App/OIDC 方向，避免长期密钥扩散。

## 价值与意义

- 减少 Secret 副本数量、撤销范围和误配置概率。
- 防止“为了自动化方便”把控制面高权限凭据散布到每个 workflow 仓库。
- 让权限和审计集中在 Vault、OIDC 或 GitHub App installation token，而不是 YAML 清单。

## 前置条件

无。需要跨仓库访问时，优先设计身份 federation、服务端代理或每仓库独立最小权限安装。

## 执行与约束方案

1. 评审中拒绝以同步 Secret 解决跨仓库访问需求。
2. 对每项跨仓库能力明确调用方身份、目标资源、有效期、权限和撤销方式。
3. 使用 GitHub App installation token、OIDC 到云/Vault 或 Gateway 签发的短期 token。

## 验收策略

- DeepAuto 仓库不存在批量读取和复制 GitHub Secret 的 workflow。
- Runner 获得的令牌与单个 Execution、仓库和时间窗绑定。
- 凭据撤销后，后续任务无法领取新 token 且有可解释错误。

## 人工决策

无。若特定外部服务不能使用短期身份，需单独提交例外设计和风险接受记录。
