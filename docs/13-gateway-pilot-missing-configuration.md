# Gateway 本地 Pilot：待补齐配置获取手册

> 状态：待配置。本文只记录配置名称、用途和安全获取方式；不要在本文、终端输出、
> Issue、PR、聊天记录或 Git 中粘贴真实值。

## 已有配置与待确认项

本地 `.env.local` 已包含数据库、Redis、GitHub App 与初始 pilot 的部分变量名。由于
Gateway 尚未有运行时配置加载器，以下值仍须在实现启动入口时显式接入并校验。

| 变量 | 当前处理 | 获取或生成方式 |
| --- | --- | --- |
| `GITHUB_WEBHOOK_SECRET` | 需生成或确认 | 使用密码管理器生成至少 32 字节随机值；同一值同时写入本地环境和 GitHub App Webhook。 |
| `DEEPAUTO_GATEWAY_URL` | 等待 tunnel 地址 | Gateway 启动后由临时 HTTPS tunnel 输出的 `https://...` 基础地址；不可预先编造。 |
| `GITHUB_WORKSPACE_ID` | 已有决策，需写入 | 本 pilot 固定为 `deepauto-local-pilot`。 |
| `GITHUB_BOT_MENTION` | 需确认 | GitHub App Bot 的实际提及文本，例如 `@<bot-login>`；以 App 安装后显示的 bot 登录名为准。 |
| `GITHUB_BOT_USER_ID` | 需确认 | 在 GitHub App 安装后，通过 GitHub API/事件 payload 中 `sender.id` 获取 Bot 数字 ID；不得使用人的 ID。 |
| `GITHUB_BOT_LOGIN` | 需确认 | GitHub App Bot 的实际登录名；用于回执识别。 |
| `DEEPAUTO_PILOT_MEMBER_ID` | 已确定，需接入 | 固定为已创建的 WorkspaceMember ID `cmvp2hu4v0000g4fyiimljk56`。 |
| `DEEPAUTO_PILOT_REPOSITORY_ID` | 已确定，需接入 | 固定为 GitHub provider repository ID `1423344804`。 |
| GitHub Actions OIDC policy | 需写入运行配置 | 配置 `DEEPAUTO_ACTIONS_OIDC_AUDIENCE`、`DEEPAUTO_ACTIONS_OIDC_REPOSITORY`、`DEEPAUTO_ACTIONS_OIDC_REPOSITORY_ID`、`DEEPAUTO_ACTIONS_OIDC_WORKFLOW_REF`、`DEEPAUTO_ACTIONS_OIDC_REF`、`DEEPAUTO_ACTIONS_OIDC_EVENT_NAME`；使用长期部署文档中固定值。 |
| Executor image | 需写入 GitHub Actions Variable | 发布 `ghcr.io/liaowenjie15/deepauto-executor` 后，将输出的 `ghcr.io/liaowenjie15/deepauto-executor@sha256:...` 写入 `DEEPAUTO_EXECUTOR_IMAGE`；只接受 digest 引用，不使用 tag。 |
| Codex proxy 配置 | 尚缺 | 需要有效的上游 HTTPS URL、API Key、模型名与随机会话签名密钥；缺失时完整执行工作流应保持关闭。 |

## 临时 HTTPS Tunnel 的正确流程

临时 tunnel 的作用是让 GitHub 能访问本机正在运行的 Gateway；它不是 Gateway 本身，
也不应作为长期域名使用。

1. 先启动本地 Gateway，并确认它仅监听例如 `127.0.0.1:3000`。
2. 安装并登录经批准的 tunnel 工具；本机当前未检测到 `cloudflared` 或 `ngrok`。
3. 启动临时 tunnel，目标为本机 Gateway 端口。工具输出一个公开 HTTPS 地址，例如
   `https://random-subdomain.example-tunnel.com`。
4. 将该地址（不加尾部 `/`）写入本地 `DEEPAUTO_GATEWAY_URL`，并同步为目标仓库的
   Actions Variable `DEEPAUTO_GATEWAY_URL`。
5. 将 GitHub App Webhook URL 设置为：
   `https://random-subdomain.example-tunnel.com/github/webhooks`。
6. 在 GitHub App 页面发送 Test delivery，再由批准管理员发一条受控评论进行验证。
7. tunnel 进程停止、机器休眠或地址变化后，立刻视为 URL 失效：更新 GitHub App
   Webhook URL 和仓库 Actions Variable，或先暂停 pilot。

临时 tunnel 地址不是任意字符串，也不能填写 `localhost`、内网 IP 或还未启动的域名。
它必须是 tunnel 工具在 Gateway 正常监听后真实生成的公开 HTTPS 地址。

## GitHub App Webhook 的详细配置流程

1. 打开 GitHub 的 **Settings → Developer settings → GitHub Apps**，选择 DeepAuto 使用的 App。
2. 进入 **General**，在 **Webhook** 区域启用 **Active**。
3. 在 **Webhook URL** 填入 `<DEEPAUTO_GATEWAY_URL>/github/webhooks`。
4. 在 **Webhook secret** 粘贴 `GITHUB_WEBHOOK_SECRET` 的同一值；不要在任何日志中回显。
5. GitHub App 页面没有 **Webhook URL content type** 下拉框；这是仓库 Webhook 的专属选项，
   GitHub App Webhook payload 默认使用 JSON。
6. 打开左侧 **Permissions & events**，在 **Subscribe to events** 中勾选 **Issue comment**；
   保持其他不需要的事件关闭。
7. 点击页面底部 **Save changes**。保存后 GitHub 会发送 ping；查看投递结果但不要复制 payload。
8. 如签名校验返回 `401`，优先核对 secret 是否一致；如 `404`，核对 tunnel 地址、Gateway
   端口与固定路径；如 tunnel 无法访问，先停止试运行而不是绕过 HTTPS。

## 安全生成与保存方法

### Webhook secret 与会话签名密钥

使用组织的密码管理器生成随机值并保存为部署 secret。若必须在本机生成，以下命令只将
结果显示在当前受控终端；不要将输出粘贴到仓库文件：

```bash
openssl rand -base64 48
```

分别生成：

- 一个 `GITHUB_WEBHOOK_SECRET`；
- 一个不少于 32 字符的 Codex session token signing secret；
- 不要复用 GitHub App 私钥、数据库密码或任何现有 token。

### Bot identity

完成 GitHub App 安装后，从目标仓库中该 App Bot 发布的评论或 GitHub API 返回中读取：

- `login` → `GITHUB_BOT_LOGIN`；
- 数字 `id` → `GITHUB_BOT_USER_ID`；
- 提及形式 `@<login>` → `GITHUB_BOT_MENTION`。

必须确认三项属于 GitHub App Bot，而非管理员 `liaowenjie15`；否则自身回执可能被再次
当作用户命令处理。

## 本地 Pilot 固定范围

| 范围 | 固定值 |
| --- | --- |
| Workspace | `deepauto-local-pilot` |
| 初始管理员 GitHub 用户 | `250161618` / `liaowenjie15` |
| WorkspaceMember | `cmvp2hu4v0000g4fyiimljk56` |
| GitHub repository ID | `1423344804` |

任何新增成员、仓库、workflow ref 或网络出口都属于新的审批决策，不能作为“补配置”直接
加入本 pilot。

## 配置完成判定

在启动临时 tunnel 前，至少要具备：Gateway 本地进程、数据库与 Redis 连通、Webhook
secret、Bot identity、pilot allowlist 与 Gateway 公开基础地址。要实际执行 GitHub Actions
工作流时，还必须具备严格的 OIDC trust policy 和 Codex proxy 配置。
