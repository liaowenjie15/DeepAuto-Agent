# Grain Niuma 与 Lark 工具实现分析及 DeepAuto 接入建议

> 分析日期：2026-11-06。只基于 `/Volumes/伊泽瑞尔/grain` 与当前 DeepAuto 工作树的静态源码；未运行外部调用、测试或验证。本文是设计参考，不表示 DeepAuto 已实现 Lark 工具。

## 1. 结论

Grain 里容易混淆的三条链路并不是同一个「Lark 工具」：

1. **Niuma 的通用飞书操作**：GitHub Actions runner 安装第三方 `@larksuite/cli`，Agent 通过 `lark-cli` 命令及仓库内 `.agents/skills/lark-*` 的操作说明，按需访问 IM、文档、Base、日历、任务等。CLI 的底层实现不在本次检查的 Grain 源码中；仓库实现的是安装、凭据注入、调用约束和若干包装脚本。
2. **飞书消息入口与调度**：Grain 后端用飞书 SDK 接长连接事件，先过滤、即时反馈，再调度 Niuma workflow。fast-responder 只拥有 `react` 和 `dispatch` 两个工具，不是文档/Base 等数据工具执行者。
3. **Grain 产品 Connector**：另有一套平台 Adapter/Connector 服务，区分中国版飞书和国际版 Lark；当前 Feishu/Lark Adapter 仅声明 `feishu.user.info`（读）与 `feishu.doc.publish`（写）。这条受控结构化工具链不能等同于 Niuma 在 runner 内可见的全部 CLI 命令。

对 DeepAuto，建议学习「能力分层、显式身份、细粒度工具与审计」，**不要照搬把应用密钥和用户 token 放入代码 Runner 并向模型开放通用 CLI** 的运行方式。现有代码执行 capability 是 PR-only，不应为了飞书工具直接扩大其权限。

## 2. Niuma 的实际调用链

```text
飞书事件 -> 后端 WebSocket 事件路由 -> fast-responder (react -> dispatch)
       -> 后端按 thread 处理活跃运行/待续消息、创建状态卡
       -> GitHub Actions workflow_dispatch -> Niuma runner
       -> Agent 按 Prompt/Skills 选择 lark-cli 或 lark-send.ts
       -> 飞书 OpenAPI -> 原召唤 thread 回执
```

- **事件入口**：`packages/backend/src/feishu/ws-client.ts:85` 限制长连接的启动环境，消息事件先短时去重并异步处理；`event-router.ts:73` 过滤 bot 回环，群聊需满足 @ 规则（另有告警等业务特例）。这个进程内去重不是可直接迁移的跨实例持久幂等保证。
- **轻量分诊**：`packages/backend/src/feishu/responder/tools.ts:92` 构造 `react`、`dispatch`；运行时保证先 reaction 再派发，限制同一条消息重复派发。`responder/index.ts:~70` 的模型不取历史、不调用飞书数据工具；失败降级为默认运行方派发。分诊的模型输出不是授权依据。
- **会话与运行**：`packages/backend/src/feishu/niuma-thread-bridge.ts` 维护 thread 对应的运行方锁、活跃 run、pending 消息与取消标记；`niuma-dispatcher.ts:2210` 发起 workflow_dispatch。状态卡和失败回执由后端/工作流处理，不能把 Agent 文字回复当作执行真相。
- **runner 装配**：`.github/workflows/niuma.yml:732` 全局安装 `@larksuite/cli`，用应用配置初始化 bot 身份；同文件约 `1183` 行单独构建 MCP 配置。因此 **Lark CLI 不是 Niuma 的 MCP Server**，其他业务 MCP 与 CLI 是并行可用的工具面。
- **按需操作**：`.github/prompts/niuma.md:16` 要求飞书召唤在原 thread 回复，`:19` 指定写/改/发使用 bot，私人上下文只读使用召唤者 user。`.agents/skills/lark-shared/SKILL.md` 描述 `--as user` / `--as bot`、scope 缺失、JSON 信封及高风险确认；`lark-doc`、`lark-base`、`lark-im`、`lark-calendar`、`lark-task` 等 Skills 细化命令、schema 与领域约束。这些 Skills 是 Agent 的操作说明，不是服务端授权控制器。
- **发消息包装**：`.github/scripts/lark-send.ts:157` 将 `send`/`reply` 映射到 CLI 命令，以 argv 而非 shell 拼接正文，默认 bot、reply 默认进 thread，可带幂等键；并规范换行、链接和 @ 标签。它解决格式与误发的局部问题，但不是全部 Lark 写操作的统一策略网关。

### Bot 与用户身份

- Bot：workflow 使用应用配置，CLI 自行取得应用级访问能力；可操作应用可见资源，发送消息以 bot 名义进行。Bot 看不到用户私人资源，并不因为用户在聊天里发了链接就自动获得访问权。参见 `.github/workflows/niuma.yml:732`、`.agents/skills/lark-shared/SKILL.md`。
- User：Grain 后端的 OAuth 授权回调校验实际授权用户，长期 refresh token 加密存储；`packages/backend/src/feishu/user-oauth.ts:404` 对同一用户刷新加事务锁并处理轮换。后端先签发短期身份 claim；runner 向内部接口提交 claim，接口验签、以 claim 内身份换取短时 token，而不是接受任意请求体 open ID（`packages/backend/src/api/rest/internal.ts:1699`）。
- runner 将 user token 放临时文件，仅在需要用户私人**只读**上下文的单条 CLI 命令上设置环境；不全局注入，以免 CLI 的外部 user token 模式禁用 bot 命令。参见 `.github/workflows/niuma.yml:803`、`.github/prompts/niuma-refs/feishu-user-identity.md`。其说明明确记载 Base 按钮召唤的 open ID 可信度弱于已验证 IM 事件：**签名只保证签发后未被篡改，不会自动提升来源身份的可信度**（`user-oauth.ts:125`、`internal.ts:1699`）。DeepAuto 不应继承这一残留边界。

### CLI 与 Connector 的差异

| 维度 | Niuma runner 的 Lark CLI | Grain 产品 Connector |
| --- | --- | --- |
| 工具发现 | CLI help/schema + 按场景加载 Skills；可用命令面较广 | Adapter 显式列举工具，Agent 经 `get_connector_schema` 查可见工具 |
| 运行位置 | GitHub Actions runner，Agent 可调用 CLI | Grain 后端服务，Agent 发结构化工具请求 |
| 身份 | 默认 bot；用户私人读取时单命令短期 user token | 用户 OAuth 连接实例，按用户/频道归属执行 |
| 飞书/Lark 区域 | Niuma workflow 明确初始化飞书品牌 | `registry.ts:200` 两份配置共用 `LarkFamilyAdapter`，域名、应用凭据和租户隔离 |
| 当前业务能力 | 依 CLI 与权限提供多域操作 | `adapter.ts:164` 的用户信息读取和文档发布两个工具 |
| 写入控制 | Skills 中意图确认和 CLI 部分高风险命令 exit 10 确认；仍需信任 Agent 遵守说明 | `service.ts:1480` 服务端校验归属、连接状态、平台开关、写 scope 和工具权限 |

Connector 的文档发布使用用户 OAuth 身份，依次上传 Markdown 素材、创建导入任务、轮询结果、处理图片；群通知是成功后的附加步骤，通知失败不重试整篇文档以免重复创建（`packages/backend/src/connector/feishu/adapter.ts:1`、`:413`）。这是特定的「内容发布」能力，不是通用的文档编辑/Base/任务接口。CLI 的高风险 exit 10 和 `--yes` 属于该 CLI 的交互协议，不能替代 DeepAuto 自己的审批与执行授权。

## 3. DeepAuto 当前落点与缺口

- `packages/lark/src/index.ts` 仅将用户文本事件规范化成共同 `InboundInvocation`，过滤 bot 和未 @ 的群消息，形成 conversation key 与幂等键；**没有飞书 SDK 长连接入口，也没有文档/Base/日历/任务工具实现**。
- `packages/db/src/authorization.ts` 已有 workspace 成员与 Lark open ID 关联的授权入口；但 `apps/gateway/src/app.ts:179` 当前接收的是 GitHub webhook，`gateway-bootstrap.ts` 未配置 Lark 事件消费。不能把 `normalizeLarkMessage` 的存在误读为完整飞书接入。
- `packages/contracts/src/capability-registry.ts:9` 的唯一执行 capability `repository.change-pr.v1` 只允许 GitHub 来源，`apps/gateway/src/dispatcher.ts:59` 在授权/入队前拒绝飞书来源和缺少 repository ID 的请求。Lark 入站标准化与真实任务执行之间还有显式准入缺口。
- `docs/03-unified-agent-architecture.md` 已约定双入口单任务模型、读/写/高风险分级、Token Vault；`docs/02-feishu-permission-scopes.md` 记载的是权限规划，不证明用户 OAuth 或这些工具已在 DeepAuto 实现。`docs/git-tasks/not-reuse/02-niuma-runtime-harness.md` 已决定不直接复制 Grain 的 runtime harness。

## 4. 建议的接入顺序

1. **先接入事件，不接数据工具**：单实例 Gateway 飞书长连接，事件快速 ACK；以平台可信事件解析 actor、chat、thread 和 workspace，持久去重，调用共同 Dispatcher。先完成私聊/@、即时反馈、原 thread 回执与失败通知。未解析成员或 workspace 时拒绝，不以消息文本补身份。
2. **定义服务端 Lark 工具目录**：按 `lark.im.reply`、`lark.doc.read`、`lark.base.record.read` 等小粒度能力登记 schema、读/写/高风险、所需身份、scope、资源归属校验、幂等策略与审计字段。第一批优先选择受限的只读资源与原 thread 回执；写入逐项开启。不要让模型传入 workspace ID、actor ID、任意 token 或内部 connector ID 来决定授权范围。
3. **用户授权与资源校验**：应用身份仅访问 bot 有权访问的资源；用户私有读取必须由已验证 Lark actor 绑定对应 workspace member 和 OAuth 连接，服务端保管、加密与串行刷新凭据。资源 token/URL 是定位符，不是所有权证明；在每次调用时检查 workspace、成员、连接、平台、scope、资源可见性与当前任务权限。飞书与国际版 Lark 的应用/租户身份不可混用。
4. **受控执行器**：由 Worker 调服务端 Provider/Adapter 调用飞书 API，模型只见窄 schema 和脱敏结果。对有外部副作用的动作，在服务端持久化执行意图/审批事实与幂等键；禁止失败后盲目重放创建、发送、修改等操作。执行后按原 thread 返回安全摘要。不要让代码 Runner 持有飞书应用密钥或用户 token；现有 GitHub PR capability 保持独立。
5. **分阶段验收**：先检查无身份、跨 workspace、错 token 类型、缺 scope、资源无权限、重复事件、并发刷新、回调重放与取消竞争的拒绝路径，再开放写工具。高风险操作必须由 DeepAuto 策略与人工确认控制；不能让模型以 `--yes` 或任意 CLI 参数绕过。

本建议是基于源码现状的设计推论，尚未选择具体 SDK、OAuth 数据模型或工具目录版本。任何正式实现应单独形成 capability 策略与安全审查，不把 Grain 的内部通用凭据、业务群配置或 workflow 约定带入 DeepAuto。
