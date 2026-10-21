# A2：建立 Workflow 安全基线模板

## 实施状态

**已实现并通过 GitHub Actions Hosted Runner 验证。** PR #6 将未指定的 workflow 权限显式设为空，并将 `id-token`、仓库内容写入和 PR 写入权限收敛到唯一需要它们的 `execute` job；同时以 `execution_id` 建立不抢占的并发组，防止重复 dispatch 并行运行同一 Execution。Hosted Runner 的完整 `validate` job 已通过（53 秒）。

同一 conversation 的 FIFO 不在本次 workflow 中重复实现：现有 Worker 已通过 Redis conversation claim 在 GitHub Actions dispatch 后将锁转交给 Execution，数据库队列按 `createdAt` 升序读取待执行 Job。

## 目的

为每条 DeepAuto workflow 固化超时、并发、最小权限、受控 checkout 和取消语义，避免重试或重复事件产生并发执行和越权凭证。

## 价值与意义

- 减少同一 Execution 被 GitHub 重跑、重复 dispatch 或连续用户请求并行执行的竞态。
- 将权限和副作用写在 workflow 层，使审查者能迅速判断执行面边界。
- 与控制面的状态锁形成两层防护：控制面保证正确性，Actions 并发控制减少浪费与意外重叠。

## 前置条件

- `execution_id`、Attempt 和取消状态已经由控制面定义。
- 已确认 Runner 写仓库是否走任务绑定代理 token，还是确实需要 `GITHUB_TOKEN` 写权限。
- **已决定**：同一 conversation 出现新任务时顺序排队，不取消正在运行的任务；控制面必须在队首 Attempt 结束后再启动下一项。

## 实现方案

1. 为每个 job 设置与任务预算匹配的 `timeout-minutes`。
2. 为同一 Execution 配置 `concurrency.group`；group 仅使用受验证的执行标识，不拼接用户自由文本。
3. workflow 默认只读；在具体 job 内申请最小的 `contents`、`pull-requests` 或 `id-token` 权限。
4. `checkout` 一律使用 `persist-credentials: false`，并明确 checkout 的 ref。
5. 在 Gateway callback 中记录 Actions run、attempt 和取消结果，不能仅以 GitHub UI 判断终态。
6. 对同一 conversation 使用控制面的 FIFO 队列；GitHub `concurrency` 只防止同一 Execution 重复运行，不能代替 conversation 队列。

## 验收策略

- 同一 `execution_id` 连续派发两次时，行为与设计一致且数据库只有一个活跃 Attempt。
- 同一 conversation 连续提交多个任务时，后一项在前一项完成、失败或取消后启动，且执行顺序可审计。
- 超时、人工取消和 workflow rerun 都能产生可解释终态。
- 无写仓库需求的 job 不持有写权限；git config 中不存在持久化默认凭证。

## 已验证的权限结论

`deepauto-execute.yml` 的交付步骤确实使用 `GH_TOKEN: ${{ github.token }}`：Codex 完成后由 workflow 创建提交、`git push origin <任务分支>`，并通过 `gh pr create` 创建 Pull Request。因此 `contents: write` 与 `pull-requests: write` 目前均有实际用途，不能直接收紧为只读。

后续优化方向不是删除这两项权限，而是把它们保留在需要交付的 job，确保 Codex 运行步骤本身不接触 `GH_TOKEN`，并继续使用 `persist-credentials: false`。

## 人工决策

- 是否在未来将“创建提交/PR”拆到独立 delivery job，以进一步缩小写权限可见的步骤范围。

## 非目标

不把 GitHub `concurrency` 当作全局分布式锁；最终幂等和会话锁仍属于 PostgreSQL/Redis 控制面。
