# A1：引入 GitHub Actions 静态检查

## 实施状态

**已实现并通过 GitHub Actions Hosted Runner 验证。** `validate.yml` 已新增独立的只读 `actionlint` job：固定下载官方 `actionlint 1.7.12` Linux AMD64 发布包，并在执行前校验 SHA-256；checkout 同时固定到 `actions/checkout v4.4.0` 的完整 commit SHA。

本地已使用同一 `actionlint 1.7.12` 完成 workflow 扫描，并通过 YAML 解析和 `git diff --check`。本机对 Linux 发布包的二次下载遇到 GitHub 网络超时；随后 PR #5 的 Hosted Runner 成功下载、校验并运行 `actionlint`（4 秒），既有完整 `validate` job 也通过（49 秒）。

## 目的

在 Pull Request 阶段检查 `.github/workflows/**` 的 GitHub Actions 语法、表达式和 job 依赖，避免错误配置进入默认分支后才在真实 Execution 中失败。

## 价值与意义

- DeepAuto 的 GitHub Actions 是外部执行器；workflow 无法启动会让控制面已创建的 Execution 停在执行边界。
- `actionlint` 覆盖 YAML 工具难以发现的 Actions 专有错误，例如错误的 context、无效 `needs` 和事件字段。
- 它是确定性、低成本、不接触 Secret 的验证，适合成为第一条 CI 护栏。

## 前置条件

- 项目继续使用 GitHub Actions 承载代码任务执行。
- CI 环境可以安装或缓存 `actionlint`；其安装方式需锁定版本。
- 已确认 `deepauto-execute.yml` 是本仓库的受管 workflow。

## 实现方案

1. 在 `.github/` 增加经确认的 `actionlint` 配置；只保留 DeepAuto 需要的例外规则。
2. 新建只读验证 workflow，在 PR 和受保护分支 push 时运行 `actionlint`。
3. 将 Action 本身固定到可审计版本；不从 Grain 复制其忽略项或可变版本引用。
4. 失败输出必须保留具体文件和表达式位置，但不得输出环境变量或 workflow dispatch 输入内容。

## 验收策略

- 构造错误的 Actions expression、无效 job 引用和错误事件字段，CI 必须失败。
- 现有 `deepauto-execute.yml` 必须通过检查。
- 该检查不申请写权限、不读取 Secret、不触发 DeepAuto Execution。

## 人工决策

- 由谁维护 `actionlint` 版本升级与例外规则审查。
- 是否将该检查设为所有仓库的 required check；建议在首轮稳定后设为必需。

## 非目标

不检查 TypeScript、Docker、运行时业务逻辑或 GitHub App 配置；这些分别由现有验证层和控制面测试负责。
