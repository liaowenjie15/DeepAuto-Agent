# B3：设计 GitHub 评论与事件触发安全协议

## 实施状态

**进行中。** `feat/github-event-security-protocol` 的提交 `b7eb1ac` 已为 GitHub 评论控制入口增加固定回执 marker、机器人 user ID 过滤与中英文精确控制命令；带 marker 的回执不会再次标准化为 Invocation，且受控回执发布时强制附加该 marker。

当前未提交增量新增 GitHub App 的仓库限定评论发布器（仅申请 `issues:write`）与 PR 检查器（仅申请 `pull_requests:read`）。已确认保留“已映射成员在 allowlist 仓库直接 `@DeepAuto <任务>`”入口；普通 Issue 评论照常进入既有授权、幂等与队列链路。PR 评论则在授权通过、创建 Job 前检查其 `head.repo.fork`：检查器未配置、查询失败、head 仓库不可用或明确为 fork 时均默认拒绝，不发布回执。拒绝仅审计 delivery ID、comment ID、仓库 ID、Issue/PR anchor、fork 判定和原因，不保存正文或原始 webhook payload。

GitHub App 已获 `issues:read:write`；实际应用组装须注入已有的 bot numeric user ID、`createGitHubAppIssueCommentPublisher(...)` 和 `createGitHubAppPullRequestInspector(...)`。相关单元与集成用例已补充，但因项目验证暂停，尚未运行测试、lint、typecheck 或 build。

## 目的

为未来的 Issue/PR 评论召唤、验证派发和自动回执定义可信协议，避免评论内容直接成为高权限执行指令。

## 价值与意义

- 防止 Agent 自己的评论、机器人评论或 fork PR 内容形成递归触发和命令注入。
- 让 GitHub 作为统一入口之一，同时不绕过 Gateway 授权和 Invocation 标准化。
- 预先约束 `pull_request_target`、fork、写 token 和 checkout head 之间的危险组合。

## 前置条件

- GitHub App 安装身份、成员映射和仓库 allowlist 已实现。
- Gateway 能生成带时效、绑定 Execution 的派发标识。
- 已有审计表记录触发事件、原始载体、标准化 Invocation 和关联 Execution。

## 实现方案

1. 仅 Gateway 或可信内部 workflow 可以写入固定 marker/签名的派发评论。
2. workflow 收到评论后先验证 PR/Issue 类型、marker、关联 Execution、调用者授权和事件幂等键。
3. fork PR 默认禁止执行其 head、禁止暴露 OIDC/写 token；如需验证，使用无密钥只读路径。
4. 所有 Agent 回执使用独立 marker，触发器必须排除这些 marker 和机器人自身 sender。

## 验收策略

- 普通用户评论、Agent 回执、重复 webhook、篡改 marker、fork PR 均不能启动高权限执行。
- 由 Gateway 发出的有效指令只启动一次，并在审计中可追溯。
- 针对 `pull_request_target` 的每一条 workflow 都有 fork/secret/checkout 的安全测试或人工审查记录。

## 人工决策

- GitHub 评论召唤是否是首期产品能力；若不是，本任务只保留协议文档和测试夹具。
- marker 使用签名、一次性 nonce 还是仅服务端查询关联记录；推荐服务端关联记录加短期 nonce。

## 非目标

不允许任意 `@deepauto` 文本直接执行，不把 GitHub 作者 association 当作唯一授权机制。
