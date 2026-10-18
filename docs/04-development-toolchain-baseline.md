# DeepAuto Agent：开发工具链基线

> 状态：首期冻结基线  
> 更新日期：2026-10-18  
> 目标：让 DeepAuto 在语言、运行时、数据库、队列和 Agent SDK 上与 Niuma 的可复用部分保持一致，避免开发机、Docker、CI 和 Runner 之间出现版本漂移。

## 1. 结论

DeepAuto 首期只使用 **TypeScript** 作为业务实现语言。

- 不引入 Python、Java、Go 等第二运行时；
- Shell 只用于容器入口、Git 操作和开发脚本；
- SQL 只通过 Prisma schema 与生成的迁移管理；
- 代码 Runner 未来会按被操作仓库的语言安装额外工具链，但那不是 DeepAuto 平台本身的基础依赖。

这与 Grain/Niuma 的后端、飞书派发器、队列、模型路由和 Harness 的主干保持同一技术族：TypeScript + Bun + PostgreSQL + Redis + BullMQ。

## 2. 固定版本

| 类别 | DeepAuto 固定版本 | 作用 | 选择依据 |
| --- | --- | --- | --- |
| Node.js | `22.23.3` | Docker / CI / Runner 的 Node 基线 | Grain 的 Node 22 编译目标与 `>=22` 运行要求 |
| Bun | `1.4.2` | 包管理、脚本、测试与本地运行 | 与 Grain 使用的 Bun 1.4 同一版本族；当前开发机已安装 |
| TypeScript | `5.9.3` | 类型检查与编译语义 | Grain 根工程使用版本 |
| Turbo | `2.11.9` | Monorepo task 编排 | 唯一的兼容性升级：Grain 的 `2.9.16` 无法解析 Bun 1.4 生成的 lockfile v2 |
| Biome | `2.4.12` | 格式化、静态检查与 import 整理 | Grain 根工程使用版本 |
| PostgreSQL | `16` + pgvector | 权威业务数据、审计、任务、授权连接 | Grain 本地开发镜像基线 |
| Redis | `7-alpine` | BullMQ 队列、锁、短期幂等和限流 | Grain 本地开发镜像基线 |
| Prisma | `7.8.0` | 数据库 schema、迁移和类型安全访问 | Grain 数据层使用版本 |
| BullMQ | `5.78.0` | 异步 Job、重试、延迟任务和 Worker | Grain 后台任务使用版本 |
| ioredis | `5.10.1` | Redis 客户端 | Grain 队列与 Redis 基础设施使用版本 |
| Hono | `4.12.23` | Webhook、健康检查和管理 API | Grain 后端 HTTP 层使用版本 |
| Zod | `4.4.3` | 输入、Webhook 与工具参数校验 | Grain 后端使用版本 |
| AI SDK | `7.0.66` | GPT / DeepSeek 模型抽象、工具调用与流式输出 | Grain 模型层使用版本 |
| 飞书 SDK | `@larksuiteoapi/node-sdk@1.66.1` | 长连接、消息、文档、Base、日历、任务 API | Grain 飞书运行时使用版本 |

版本必须同时写入 `package.json`、Bun lockfile、`.node-version` 和 Docker 镜像，不使用漂移的 `latest` 标签。

## 3. 已安装与待安装

### 当前开发机已具备

| 工具 | 当前状态 | 用途 |
| --- | --- | --- |
| Git | 已安装 | 克隆、分支、提交与 Worktree |
| `fnm` + Node.js | 已安装（`fnm 1.39.0`，项目内自动切换到 `22.23.3`） | 固定本机、Docker、CI 与 Runner 的 Node 基线；系统自带 Node 26 不参与项目运行 |
| Bun | 已安装（1.4.2） | DeepAuto 的本地包管理与脚本运行时 |
| `lark-cli` | 已安装（1.0.98） | 飞书开发授权、诊断和 skill 验证，不用于生产执行 |
| GitHub CLI (`gh`) | 已安装（2.102.0） | 本机验证 GitHub App、仓库和 Pull Request；登录与 App 配置在 GitHub 接入阶段完成 |

### 必须补齐

| 工具 | 原因 |
| --- | --- |
| Docker Desktop | 启动 PostgreSQL、Redis、后续 Gateway / Worker / Runner 容器；安装需要在本机交互终端输入 macOS 管理员密码 |
| Docker Compose plugin | 随 Docker Desktop 提供，用 `docker compose` 统一启动本地依赖 |

### 暂缓安装

- Next.js、React、assistant-ui：内部控制台开始开发时再加；
- OpenSearch：Grain 的内容搜索依赖，不是 DeepAuto 首期能力；
- Python / Java / Go：只在 Agent 未来操作对应语言仓库时放进专用 Runner 镜像；
- Gitee SDK：GitHub 是首期唯一代码平台；
- Kubernetes、云数据库、云消息队列：本机 Docker 验证完成后再决策。

## 4. 项目结构与包边界

```text
apps/
  gateway/          飞书长连接、GitHub Webhook、快速 ACK
  worker/           Dispatcher、模型调用、工具编排、任务回执
  admin-web/        后续内部控制台，不是首期前置

packages/
  contracts/        Invocation、Job、Audit、Provider 的共享类型和 schema
  db/               Prisma schema、迁移、数据库 client
  lark/             飞书 SDK 与 Docs/Base/Calendar/Task Provider
  github/           GitHub App、Webhook、仓库与 Pull Request Provider
  agent-core/       模型路由、工具策略、确认与执行状态机
  runner-manager/   隔离 Worktree / Docker Runner 的受控创建与回收
```

任何业务功能都必须落入一个明确 package，禁止让 Gateway、Worker 或 Provider 互相引用实现细节。

## 5. 本机基础设施

`compose.yaml` 只启动平台依赖：

```text
PostgreSQL 16 + pgvector  →  localhost:5432
Redis 7                   →  localhost:6379
```

启动命令：

```bash
bun run infra:up
```

停止命令：

```bash
bun run infra:down
```

Gateway、Worker 和一次性代码 Runner 在 Phase 0 有可运行实现后再添加到 Compose。这样可以先稳定数据库与队列，避免尚未实现的服务掩盖基础设施问题。

## 6. 版本与安装规则

1. 业务依赖只通过 Bun 安装，禁止混用 npm、pnpm 或 yarn 写锁文件。
2. 运行 `bun install` 后必须提交 `bun.lock`。
3. Node 22.23.3 是 Docker、CI 与 Runner 的唯一基线；本机 Node 26 不能用于生成与 Node 22 不兼容的产物。
4. Turbo 不得低于 `2.11.9`；Bun 1.4 的 `bun.lock` 使用 lockfile v2，旧版 Turbo 会失去 workspace 依赖图和远程缓存能力。
5. 新增原生依赖时必须验证 `darwin/arm64` 和未来 Runner 的 `linux/arm64` 兼容性。
6. 数据库迁移只能由 Prisma 生成；不手写迁移文件。
7. Redis 只存队列、锁、缓存和短期幂等；审计、授权、资源归属和任务最终状态必须进 PostgreSQL。
8. `lark-cli` 仅存在于开发 / 诊断环境。Gateway 与 Worker 只能使用飞书 Node SDK / OpenAPI。

## 7. 安装顺序

1. 安装并启动 Docker Desktop；
2. 安装 GitHub CLI；
3. 在仓库根目录执行 `bun install`；
4. 执行 `bun run infra:up`，确认 PostgreSQL 和 Redis 的 healthcheck 为健康；
5. 再创建 `packages/db`、`apps/gateway` 与 `apps/worker` 的最小骨架；
6. 运行时依赖按 workspace 预装并锁定版本；具体实现仅在基础设施健康检查通过后开始。

在第 4 步没有通过前，不开始飞书业务功能、GitHub Webhook 或代码 Runner 的实现。

## 8. 当前安装收尾

已完成：`fnm`、精确版 Node `22.23.3`、Bun `1.4.2`、Git、`gh`、`lark-cli`，以及以下受版本锁定保护的 workspace 依赖：

- `packages/db`：Prisma、PostgreSQL 驱动与 Prisma PostgreSQL adapter；
- `packages/lark`：飞书 Node SDK；
- `packages/github`：GitHub App JWT 所需的 `jose` 与请求校验；
- `packages/agent-core`：AI SDK、GPT Provider 与 DeepSeek OpenAI-compatible Provider；
- `apps/gateway`、`apps/worker`：Hono、BullMQ、ioredis 与各 Provider workspace；
- `packages/runner-manager`：Docker Engine Node client。

Docker Desktop 因为需要创建 macOS 受保护的系统链接，必须在用户自己的交互式终端完成一次安装：

```bash
brew install --cask docker-desktop
```

安装结束后，从「应用程序」启动 Docker，按界面完成首次初始化。待菜单栏显示 Docker 已运行后，执行：

```bash
cd "/Users/liaowenjie/Desktop/DeepAuto Agent"
docker --version
docker compose version
bun run infra:up
docker compose ps
```

预期结果是 `postgres` 和 `redis` 均为 `healthy`。只有这一检查通过，才进入数据库、队列、Gateway 和 Worker 的代码骨架阶段。
