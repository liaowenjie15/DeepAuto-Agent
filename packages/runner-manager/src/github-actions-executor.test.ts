import { expect, test } from 'bun:test';
import {
  GitHubRequestError,
  type GitHubWorkflowDispatch,
  type GitHubWorkflowRun,
} from '@deepauto/github';
import {
  type ExecutorStartError,
  GitHubActionsExecutor,
} from './github-actions-executor';

const workflowRun: GitHubWorkflowRun = {
  id: 41,
  status: 'in_progress',
  conclusion: null,
  url: 'https://github.com/example/repository/actions/runs/41',
};

function controller(
  overrides: {
    dispatch?: (input: GitHubWorkflowDispatch) => Promise<void>;
    getRun?: (runId: number) => Promise<typeof workflowRun>;
    cancelRun?: (runId: number) => Promise<void>;
  } = {},
) {
  return {
    async dispatch(input: GitHubWorkflowDispatch) {
      await overrides.dispatch?.(input);
    },
    async getRun(input: { runId: number }) {
      return (await overrides.getRun?.(input.runId)) ?? workflowRun;
    },
    async cancelRun(input: { runId: number }) {
      await overrides.cancelRun?.(input.runId);
    },
  };
}

test('dispatches the fixed sandbox workflow with a one-time bootstrap capability', async () => {
  const dispatches: GitHubWorkflowDispatch[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async dispatch(input) {
        dispatches.push(input);
      },
    }),
  );

  await expect(
    executor.start({
      executionId: 'execution-1',
      bootstrapCapability: 'a'.repeat(43),
    }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
  });
  expect(dispatches).toEqual([
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      ref: 'main',
      inputs: {
        execution_id: 'execution-1',
        bootstrap_capability: 'a'.repeat(43),
      },
    },
  ]);
});

test('matches only its configured provider repository ID', () => {
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller(),
  );

  expect(executor.isConfiguredForRepository('1001')).toBe(true);
  expect(executor.isConfiguredForRepository('1002')).toBe(false);
});

test('rejects an invalid configured repository before dispatching', () => {
  expect(
    () =>
      new GitHubActionsExecutor(
        {
          repository: 'invalid repository',
          repositoryId: '1001',
          workflow: 'deepauto-execute.yml',
          workflowRef: 'main',
        },
        controller(),
      ),
  ).toThrow('Repository must be owner/repository');
});

test('rejects a workflow that is not registered for execution', () => {
  expect(
    () =>
      new GitHubActionsExecutor(
        {
          repository: 'liaowenjie15/deepauto-harness-sandbox',
          repositoryId: '1001',
          workflow: 'unregistered.yml',
          workflowRef: 'main',
        },
        controller(),
      ),
  ).toThrow('GitHub Actions workflow is not registered');
});

test('preserves whether a failed GitHub dispatch is retryable', async () => {
  const retryableExecutor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async dispatch() {
        throw new GitHubRequestError('workflow dispatch', 503, 'Unavailable');
      },
    }),
  );
  const terminalExecutor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async dispatch() {
        throw new GitHubRequestError('workflow dispatch', 403, 'Forbidden');
      },
    }),
  );

  await expect(
    retryableExecutor.start({ executionId: 'execution-1' }),
  ).rejects.toMatchObject({
    retryable: true,
  } satisfies Partial<ExecutorStartError>);
  await expect(
    terminalExecutor.start({ executionId: 'execution-1' }),
  ).rejects.toMatchObject({
    retryable: false,
  } satisfies Partial<ExecutorStartError>);
});

test('maps a persisted GitHub Actions run to executor status', async () => {
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async getRun() {
        return workflowRun;
      },
    }),
  );

  await expect(
    executor.getStatus({ executionId: 'execution-1', externalRunId: 41n }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    state: 'running',
    externalRunId: 41n,
    externalUrl: 'https://github.com/example/repository/actions/runs/41',
  });
});

test('cancels only the persisted run for an active execution', async () => {
  const cancelledRunIds: number[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async getRun() {
        return { ...workflowRun, status: 'queued' };
      },
      async cancelRun(runId) {
        cancelledRunIds.push(runId);
      },
    }),
  );

  await expect(
    executor.cancel({ executionId: 'execution-1', externalRunId: 41n }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    state: 'cancelling',
    externalRunId: 41n,
    externalUrl: 'https://github.com/example/repository/actions/runs/41',
  });
  expect(cancelledRunIds).toEqual([41]);
});

test('does not cancel a completed GitHub Actions run', async () => {
  const cancelledRunIds: number[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async getRun() {
        return {
          ...workflowRun,
          status: 'completed',
          conclusion: 'success',
        };
      },
      async cancelRun(runId) {
        cancelledRunIds.push(runId);
      },
    }),
  );

  await expect(
    executor.cancel({ executionId: 'execution-1', externalRunId: 41n }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    state: 'completed',
    externalRunId: 41n,
    externalUrl: 'https://github.com/example/repository/actions/runs/41',
  });
  expect(cancelledRunIds).toEqual([]);
});

test('uses a persisted Run ID without scanning workflow runs again', async () => {
  const runIds: number[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      repositoryId: '1001',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async getRun(runId) {
        runIds.push(runId);
        return { ...workflowRun, status: 'completed', conclusion: 'success' };
      },
    }),
  );

  await expect(
    executor.getStatus({ executionId: 'execution-1', externalRunId: 41n }),
  ).resolves.toMatchObject({ state: 'completed', externalRunId: 41n });
  expect(runIds).toEqual([41]);
});
