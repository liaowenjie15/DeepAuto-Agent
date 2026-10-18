# DeepAuto Agent：飞书权限 Scope 配置记录

> 记录日期：2026-10-18  
> 状态：以下“用户身份权限”已在飞书开放平台完成勾选。  
> 前置文档：[01-feishu-bot-setup.md](./01-feishu-bot-setup.md)

## 1. 权限模型

DeepAuto 的飞书权限分为两类，不能混用：

| 类型 | Token | 用途 |
| --- | --- | --- |
| 应用身份权限 | `tenant_access_token` | 机器人收发消息、添加 reaction、创建/修改机器人有权访问的文档和表格 |
| 用户身份权限 | `user_access_token` | 用户 OAuth 授权后，只读访问“用户有权限、但机器人不可访问”的私人资源 |

安全边界：

- 用户身份 token 只用于**读取**私有上下文。
- 创建文档、写表格、发送消息等**写操作始终使用 bot 的应用身份 token**。
- 应用后台已开通用户身份权限，不代表机器人自动获得所有用户的私有数据；每位用户仍需完成 OAuth 授权。
- 用户最终获得的 scope 是：`OAuth 请求范围 ∩ 应用已开通权限 ∩ 用户同意范围`。

## 本地凭证配置

- 把项目根目录的 `.env.example` 复制为 `.env.local`，填入 DeepAuto 飞书应用的 `LARK_APP_ID` 和 `LARK_APP_SECRET`。`.env.local` 只留在本机，不能提交到 Git。
- `lark-cli` 的应用初始化和用户 OAuth 授权独立于项目环境变量；完成 CLI 安装后，另行执行 `lark-cli config init --new` 和所需的 `lark-cli auth login`。
- 用户身份 token 由 `lark-cli` 管理，不写入项目 `.env.local`。

## 2. 已配置的用户身份权限

以下 scope 已在飞书开放平台的 **权限管理 → 用户身份权限** 中勾选。

### 2.1 OAuth 持久授权

```text
offline_access
```

用途：获取 `refresh_token`，使后端能够在用户首次授权后刷新短期 `user_access_token`，而不是每次访问私有资源都要求用户重新登录。

### 2.2 用户私有文档、云盘、知识库与表格（只读）

```text
docx:document:readonly
docs:doc:readonly
docs:permission.member:readonly
wiki:wiki:readonly
sheets:spreadsheet:readonly
bitable:app:readonly
drive:drive:readonly
drive:file:readonly
drive:drive.search:readonly
search:docs:read
```

用途：读取用户可访问的飞书文档、旧版 Docs、协作者信息、知识库、电子表格、多维表格、云盘文件及文档搜索结果。

### 2.3 用户与通讯录（只读）

```text
contact:user:search
contact:user.base:readonly
contact:contact.base:readonly
contact:department.base:readonly
```

用途：按姓名或邮箱查找成员、解析 `open_id`、读取成员与部门基础资料。

### 2.4 私有聊天与群聊上下文（只读）

```text
im:message:readonly
im:chat:readonly
search:message
```

用途：读取用户可访问的消息、群聊基础信息及消息搜索结果。

> 这些权限只在用户 OAuth 授权后使用；它们不等价于机器人接收实时 `@` 消息的权限。

### 2.5 日历、会议与妙记（只读）

```text
calendar:calendar:readonly
vc:meeting.search:read
vc:meeting:readonly
vc:meeting.meetingevent:read
vc:note:read
vc:record:readonly
minutes:minutes:readonly
minutes:minutes.search:read
minutes:minutes.artifacts:read
minutes:minutes.transcript:export
```

用途：读取用户日历、会议、会议纪要、录制信息、妙记、妙记产物和逐字稿。

### 2.6 飞书任务（只读）

```text
task:task:read
task:tasklist:read
task:comment:read
```

用途：读取用户可访问的任务、任务清单和任务评论。

## 3. 应用身份权限：聊天 MVP 必需项

下面这些是机器人本身使用 `tenant_access_token` 运行聊天闭环所需的权限，应在 **权限管理 → 应用身份权限** 中配置：

```text
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message:send_as_bot
im:message.reactions:write
```

对应能力：

| Scope | 能力 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户私聊机器人的消息 |
| `im:message.group_at_msg:readonly` | 接收群聊中用户明确 @ 机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份发送/回复文本、状态卡片和通知 |
| `im:message.reactions:write` | 添加或删除消息表情回复 |

聊天权限之外，还必须在 **事件与回调** 中使用长连接并订阅：

```text
im.message.receive_v1
```

`im.message.receive_v1` 是事件，不是 scope；权限勾选完成后仍必须订阅该事件并发布应用版本，后端才会实际收到消息。

## 4. 后续由 bot 执行写操作时再配置的应用身份权限

以下 scope 对应 DeepAuto 后续写操作。可以提前在应用身份权限中申请，但后端在对应工具实现、审计和确认机制完成前不得向 Agent 暴露。

```text
docx:document
docs:doc
drive:drive
drive:file
wiki:wiki
sheets:spreadsheet
bitable:app
```

| Scope | 后续能力 |
| --- | --- |
| `docx:document` / `docs:doc` | 创建、读取、编辑飞书文档 |
| `drive:drive` / `drive:file` | 创建、组织、上传、下载云盘资源和附件 |
| `wiki:wiki` | 在知识库中创建和管理节点 |
| `sheets:spreadsheet` | 创建和修改电子表格 |
| `bitable:app` | 创建和修改多维表格、字段和记录 |

若支持“在文档评论区 @DeepAuto 召唤 Agent”，还需要：

```text
docs:event:subscribe
docs:document.comment:read
docs:document.comment:create
```

并在事件与回调中订阅：

```text
drive.notice.comment_add_v1
```

## 5. 尚未实现时的运行规则

虽然用户身份 scope 已开通，第一阶段后端仍应遵循：

1. 不创建 OAuth 登录链接。
2. 不请求、不保存、不刷新任何 `user_access_token` 或 `refresh_token`。
3. 不向 Agent 暴露文档、云盘、日历、妙记、通讯录或任务工具。
4. 只启用机器人聊天最小闭环：接收消息、reaction、线程回复、异步 Agent 调用。
5. 每增加一个工具，再明确它使用 bot token 还是 user token、只读还是写入、是否需要用户确认、如何审计。

## 6. 与非飞书能力的边界

以下能力不能通过飞书 scope 配置获得，需要独立集成和独立权限模型：

| 能力 | 需要的配置 |
| --- | --- |
| 拉取仓库、改代码、创建 PR | GitHub App / GitHub OAuth / Fine-grained PAT 与仓库授权 |
| PR 代码审查 | GitHub API、CI 与 Agent 工具权限 |
| 发邮件、邮件报告 | Google Workspace OAuth / Gmail API 或外部邮件服务 |
| Agent 并发、线程 pending、幂等 | Redis / 数据库 |
| 用户 OAuth token 加密保存 | 数据库与应用加密密钥 |
