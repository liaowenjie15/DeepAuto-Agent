# DeepAuto 飞书 `UNKNOWN` 恢复控制面设计

> 状态：设计完成，尚未开放恢复接口。本文只依据当前仓库源码；没有发起飞书或 GitHub 的真实请求。

## 1. 结论

当前不能安全地提供“管理员重试”按钮或 HTTP 修复接口。`UNKNOWN` 的含义是外部副作用可能已经发生：再次执行可能重复回复、重复追加文档内容、重复更新记录，或重复删除失败后的资源。因此恢复控制面必须先满足以下条件：

1. 操作人身份由服务端验证并映射到当前 `WorkspaceMember`，且角色为 `ADMIN`；请求中的 workspace、成员、调用或数据库 ID 不构成授权依据。
2. 每个待恢复对象都有服务端创建的、不透明恢复案件号；案件的工作区、资源、原操作者和状态均由数据库读取。
3. 恢复先进行只读的远端状态核验。没有确定证据时，案件保持 `UNKNOWN`，绝不自动重试原副作用。
4. 任何会产生新外部副作用的补救动作都须在核验结果之后单独确认、单独幂等并审计；它不能复用原始工具调用或原始工作流尝试。

在这些前提未实现前，当前 Worker 保持“一旦未知即不重试”的行为。

## 2. 当前事实与缺口

### 2.1 已有 fail-closed 行为

- `packages/db/src/lark-message.ts` 的 `finishLarkDelivery` 将已经 claim 的 acknowledgement/final reply 标为 `SENT` 或 `UNKNOWN`；超时 claim 由 `markStaleLarkDeliveriesUnknown` 转为 `UNKNOWN` 并写入系统审计。
- 同文件的 `markStaleLarkMessagesUnknown` 将超时的消息处理 claim 设为 `UNKNOWN`，不会重新放回队列。
- `packages/db/src/lark-tool-operation.ts` 对飞书写工具保存加密快照；结果不确定时状态为 `UNKNOWN`，不会再次声明同一工具写入。
- `apps/worker/src/lark-chat-runtime.ts` 对未知处理结果只给出“请核对”的回复路径，不会将其作为可重试任务。

这些状态正确地表达了“DeepAuto 不知道远端是否已成功”，不是“确定失败”。

### 2.2 身份与远端读取尚不具备恢复条件

- 入站飞书消息已经通过 `authorizeInboundInvocation` 映射到数据库成员；这是未来恢复命令可使用的服务端身份来源。
- Gateway 目前只有 GitHub webhook、GitHub Actions OIDC callback 与飞书 OAuth callback 路由；没有供人工管理员登录的会话、CSRF 防护或管理 UI。因此不能新增一个仅依赖 bearer token、workspace 参数或 invocation ID 的修复 HTTP 路由。
- `packages/lark/src/client.ts` 的 `FeishuClient` 只暴露 `react` 与 `reply`。它没有读取 reaction、按幂等键查回复或查询消息线程的能力，不能证明超时请求没有在远端生效。
- `LarkToolOperation` 保存的是加密快照，普通调用方不应读取；恢复检查只能在受控 Worker 中按资源类型调用专门的只读探针。

## 3. 拟议控制面

### 3.1 恢复案件而非直接修复

新增 `LarkRecoveryCase`（名称可在实现时调整），每次把 Lark delivery、processing 或工具写操作转为 `UNKNOWN` 时，在**同一事务**创建或复用一条案件：

| 字段 | 用途 |
| --- | --- |
| `publicId` | 随机不透明案件号；是唯一可出现在面向管理员消息中的标识，不采用数据库主键。 |
| `workspaceId`、`kind`、`subjectId` | 服务端绑定的范围与目标；`subjectId` 只在数据库内使用。 |
| `state` | `OPEN`、`INSPECTING`、`EVIDENCE_CONFIRMED`、`INDETERMINATE`、`RESOLVED`、`CLOSED`。 |
| `openedAt`、`inspectedAt`、`closedAt` | 生命周期与并发 claim 的审计事实。 |
| `evidenceHash` | 探针输出的最小化摘要哈希；不存飞书正文、原始 webhook 或令牌。 |
| `openedBySystem`、`resolvedByActorId` | 分别记录系统转未知与服务器验证过的管理员。 |

`publicId` 只是定位案件的能力，不是授权凭据。每次读取或变更案件仍按服务端查得的管理员、工作区和案件状态验证。

### 3.2 管理员身份入口

第一版只接受**已授权飞书私聊中的确定性恢复命令**，而不是模型工具、自然语言推断或公开 Gateway 路由：

```text
管理员私聊机器人：恢复检查 RC_<不透明案件号>
  -> SDK 已验证事件来源
  -> parseLarkSdkMessage 规范化身份与 tenant
  -> authorizeInboundInvocation 从 WorkspaceMember 派生 actorId/role
  -> 仅 ADMIN、仅当前 workspace、仅私聊继续
  -> 在数据库中按 publicId 查询案件并再次验证 scope
  -> 创建一次 inspection claim，交给受控 Worker
```

命令解析必须在 `runLarkChatAgent` 之前进行，不能让上游模型选择目标、动作或权限范围。`OPERATOR` 可继续执行已有的受控文档/Base 写入，但 `UNKNOWN` 恢复是跨副作用的高风险操作，第一版收紧为 `ADMIN`。

将来如引入 Web 控制台，必须使用企业 OIDC/会话认证，并在服务端把稳定 subject 映射到 `WorkspaceMember` 后才能复用同一服务；不能把控制台传来的 workspace/member/invocation ID 当作身份。

### 3.3 只读核验矩阵

| 案件种类 | 核验需要的新增只读能力 | 可自动结论 | 禁止行为 |
| --- | --- | --- | --- |
| acknowledgement `UNKNOWN` | 按原消息查询 bot reaction，且结果可证明本应用已写入 | 明确存在时标为已送达 | 再次加 reaction 作为“检查” |
| final reply `UNKNOWN` | 按原消息/thread 查询由本 bot、带恢复专用幂等标记的回复 | 明确存在时记录已送达 | 重发原最终回复 |
| processing `UNKNOWN` | 查询绑定 Job/Execution 的 GitHub Actions 终态及 callback 状态 | 已有确定终态时走既有持久化收尾 | 创建新 Attempt 或重新 dispatch |
| `doc.append` `UNKNOWN` | 只有可证明的服务端写入 ID 或专用不可变标记才可判断 | 证据完备时关闭案件 | 再追加原文本 |
| Base create/update/delete `UNKNOWN` | 以受限只读 token 查询目标记录，并与加密快照的期望状态比对 | 仅在状态唯一可判定时关闭案件 | 依据“记录不存在”推断 delete 成功，或重放写操作 |

任何探针缺少所需 scope、目标不可读、结果超时或结果无法唯一归因时，状态为 `INDETERMINATE`。系统回复只说明“仍无法确认”，不泄露案件内部目标、哈希或远端响应。

### 3.4 人工补救的后续确认

`EVIDENCE_CONFIRMED` 只允许关闭案件；它不需要再次调用飞书。若管理员决定发送一条新的、明确标为补救的通知，流程必须：

1. 显示无敏感摘要的核验结论和补救动作名称；
2. 要求同一 `ADMIN` 发送第二条确定性确认命令；
3. 创建新的、独立的 delivery/operation 记录和幂等键；
4. 使用新内容与新回执，不重放原内容、原加密快照或原工具调用；
5. 将管理员、案件号、核验证据哈希和补救操作审计到 `AuditEvent`。

若案件仍是 `INDETERMINATE`，第一版不提供补救写入或发送选项。

## 4. 实施顺序与验收

1. **先补只读探针能力**：为 Feishu message/reaction/thread 与每种可写 Base 资源建立最小只读客户端；为每个 API 记录 tenant、bot/user 身份和可证明的归因字段。没有可证明探针的动作永远不可恢复。
2. **再持久化案件与审计**：迁移、部分唯一 claim、过期释放和状态机均在 DB 事务中完成；所有查询受 workspace、tenant、案件状态约束。
3. **再接入确定性管理员命令**：测试至少覆盖非私聊、非 ADMIN、跨 workspace、伪造 publicId、并发检查、过期 claim 与撤销成员身份。
4. **最后考虑人工补救**：它必须有新的二次确认和独立外部幂等记录；在真实飞书沙箱验证每一种“已成功 / 已失败 / 无法判断”响应前，保持 feature flag 关闭。

验收标准不是“能再次发消息”，而是：没有服务器派生的管理员身份、没有确定远端证据、没有独立确认时，系统始终拒绝变更或重发。

## 5. 本阶段交付边界

本阶段只完成设计和实现门槛确认，**没有**添加恢复 API、恢复命令、数据库案件表或任何自动重试。这样避免在缺失身份会话和远端只读证据时制造一个表面可用但会重复副作用的接口。
