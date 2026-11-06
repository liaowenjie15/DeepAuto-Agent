# Gateway 长期运行部署手册

> 状态：待执行。本文描述受控 pilot 验证完成后，Gateway 的长期 HTTPS
> 运行方案；不适用于临时 tunnel 的地址，也不记录任何真实凭据。

## 目标与边界

Gateway 是 GitHub Webhook、GitHub Actions OIDC 与 Codex 代理请求的唯一
入口。长期运行时应满足：

- 仅公开一个可信 HTTPS 域名，例如 `https://gateway.example.com`；
- Gateway 应用端口仅在宿主机或私有容器网络监听；
- PostgreSQL、Redis、Worker 端口不对公网开放；
- 继续使用受限 pilot allowlist：一个 Workspace、指定成员和仓库；
- 所有密钥由部署平台的 Secret Store 或受限的环境文件提供，绝不进入 Git。

当前仓库尚缺 Gateway 的进程入口、镜像与 Compose 服务；先补齐这些资产并完成
本地验证，才可按照本文部署。

## 长期架构

```text
GitHub Webhook / GitHub-hosted Actions
                  |
             HTTPS :443
                  |
     反向代理或托管平台的负载均衡器
                  |
       私有网络中的 Gateway 进程
                  |
        PostgreSQL + Redis + Worker
```

反向代理必须完整转发 `Authorization` 请求头。Gateway 依赖该头中的 GitHub
Actions OIDC token 来验证 bootstrap、session 与 callback 请求。

## 一次性基础设施配置

1. 选择托管方式：推荐托管容器平台，或在单台受控服务器上以 Caddy 作为反向代理。
2. 申请专用域名，例如 `gateway.example.com`，并为其创建 DNS 记录指向入口。
3. 配置 HTTPS 证书及自动续期。禁止将应用端口直接暴露到公网。
4. 创建受限的 Secret Store；Gateway、Worker 与数据库使用不同的最小权限身份。
5. 配置监控：HTTP 5xx、Webhook 验签失败激增、OIDC 拒绝、队列积压、数据库连接失败。

## Gateway 运行配置

以下配置放入部署平台的 Secret/Environment，不放入仓库 Actions Variable：

| 配置 | 类型 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | Secret | Gateway 可连接的数据库地址。 |
| `REDIS_URL` | Secret | Gateway 用于队列通知的 Redis 地址。 |
| `GITHUB_WEBHOOK_SECRET` | Secret | 与 GitHub App Webhook 设置完全一致的随机值。 |
| `GITHUB_APP_ID` | Secret/配置 | GitHub App 标识。 |
| `GITHUB_APP_INSTALLATION_ID` | Secret/配置 | 目标仓库的 App installation 标识。 |
| `GITHUB_APP_PRIVATE_KEY` | Secret | GitHub App PEM 私钥。 |
| `GITHUB_WORKSPACE_ID` | 配置 | 允许处理的 DeepAuto Workspace。 |
| `GITHUB_BOT_MENTION` | 配置 | 受理评论所需的 Bot 提及文本。 |
| `GITHUB_BOT_USER_ID` | 配置 | 防止 Bot 自己的评论递归触发。 |
| `GITHUB_BOT_LOGIN` | 配置 | 用于评论回执的 Bot 登录名。 |
| `DEEPAUTO_*` pilot allowlist | 配置 | 仅允许已批准的 workspace、member 与 repository。 |
| `CODEX_*` 代理配置 | Secret/配置 | Codex 上游与会话签名配置；缺失时不能执行完整工作流。 |

`DEEPAUTO_GATEWAY_URL` 是公开 HTTPS **基础地址**，例如
`https://gateway.example.com`；不附加路径、端口、尾部斜杠、账号或 token。

## GitHub 配置

### GitHub Actions Variable

在目标仓库 **Settings → Secrets and variables → Actions → Variables** 创建：

```text
DEEPAUTO_GATEWAY_URL=https://gateway.example.com
```

这不是 Secret，因为其值只是公开地址；不可在该变量中放入任何凭据。

### GitHub App Webhook

在 GitHub App 的 **General → Webhook** 中配置：

| 字段 | 正确值 |
| --- | --- |
| Webhook URL | `https://gateway.example.com/github/webhooks` |
| Webhook secret | 与 `GITHUB_WEBHOOK_SECRET` 相同的值 |
| Content type | GitHub App 没有该下拉框；其 Webhook payload 默认使用 JSON。 |
| Active | 启用 |
| 订阅事件 | `Issue comments` |

Webhook URL **不能随便填写**。它必须由已经正常工作的公开基础地址拼接固定路径
`/github/webhooks` 得到；地址不可达、路径不对或 secret 不一致时，Gateway 会拒绝
或收不到 GitHub 的投递。

### GitHub Actions OIDC 信任策略

生产配置必须将下列值固定为被批准仓库与工作流，不能接受通配符或调用方传入的值：

```text
audience:     deepauto-actions
repository:   liaowenjie15/DeepAuto-Agent
workflowRef:  liaowenjie15/DeepAuto-Agent/.github/workflows/deepauto-execute.yml@refs/heads/main
ref:          refs/heads/main
eventName:    workflow_dispatch
```

如工作流文件、分支或仓库发生变更，先审查并更新该策略，再部署；不可为“方便”放宽
其中任一声明。

## 部署顺序

1. 在隔离环境执行数据库 migration，并确认旧的 `QUEUED` Job 已取消或清空。
2. 创建并校验 Gateway 配置；启动时应在关键安全配置缺失时失败关闭。
3. 部署 Gateway，先仅在私有网络监听；验证健康检查、数据库和 Redis 连接。
4. 部署反向代理/托管入口，完成 DNS 与 HTTPS 证书后，从外网验证路由。
5. 写入仓库 Actions Variable `DEEPAUTO_GATEWAY_URL`。
6. 在 GitHub App 中填写 Webhook URL 和同一个 Webhook secret，订阅 `Issue comments`。
7. 仅以批准的管理员、仓库及受控命令发起一次端到端试运行。
8. 审查 audit event、Webhook 投递记录、GitHub Actions 日志和 Worker 日志；未通过前不扩大 allowlist。

## 验收与回滚

- 从外网向受保护的 Actions 路由发送无 OIDC token 的请求，应返回 `401`，而不是
  `200` 或公开内部数据。
- GitHub Webhook 的 test delivery 应得到 `202` 或受控的 `4xx`；任何 `5xx` 都必须先
  排查再重投递。
- 暂停入口：在 Gateway pilot admission 中设置 `enabled: false` 或停止 Gateway 服务；
  不要通过删除审计数据实现暂停。
- 凭据疑似泄露时：立即禁用 App 安装或旋转私钥与 webhook secret，随后停止 Gateway，
  取消未完成执行并审计受影响记录。

## 相关代码与文档

- `apps/gateway/src/app.ts`
- `.github/workflows/deepauto-execute.yml`
- `docs/pending-tasks/01-gateway-public-https-reverse-proxy.md`
- `docs/pending-tasks/02-controlled-pilot-rollout.md`
