import { expect, test } from 'bun:test';
import {
  GitHubRequestError,
  type GitHubWorkflowDispatch,
} from '@deepauto/github';
import {
  type ExecutorStartError,
  GitHubActionsExecutor,
} from './github-actions-executor';

const workflowRun = {
  id: 41,
  status: 'in_progress',
  conclusion: null,
  url: 'https://github.com/example/repository/actions/runs/41',
};

function controller(
  overrides: {
    dispatch?: (input: GitHubWorkflowDispatch) => Promise<void>;
    findRun?: () => Promise<typeof workflowRun | null>;
    cancelRun?: (runId: number) => Promise<void>;
  } = {},
) {
  return {
    async dispatch(input: GitHubWorkflowDispatch) {
      await overrides.dispatch?.(input);
    },
    async findRun() {
      return (await overrides.findRun?.()) ?? null;
    },
    async cancelRun(input: { runId: number }) {
      await overrides.cancelRun?.(input.runId);
    },
  };
}

test('dispatches the fixed sandbox workflow with only an execution reference', async () => {
  const dispatches: GitHubWorkflowDispatch[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async dispatch(input) {
        dispatches.push(input);
      },
    }),
  );

  await expect(executor.start({ executionId: 'execution-1' })).resolves.toEqual(
    {
      executionRef:
        'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    },
  );
  expect(dispatches).toEqual([
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      ref: 'main',
      inputs: { execution_id: 'execution-1' },
    },
  ]);
});

test('rejects an invalid configured repository before dispatching', () => {
  expect(
    () =>
      new GitHubActionsExecutor(
        {
          repository: 'invalid repository',
          workflow: 'deepauto-execute.yml',
          workflowRef: 'main',
        },
        controller(),
      ),
  ).toThrow('Repository must be owner/repository');
});

test('preserves whether a failed GitHub dispatch is retryable', async () => {
  const retryableExecutor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
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

test('maps a matched GitHub Actions run to executor status', async () => {
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async findRun() {
        return workflowRun;
      },
    }),
  );

  await expect(
    executor.getStatus({ executionId: 'execution-1' }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    state: 'running',
    externalUrl: 'https://github.com/example/repository/actions/runs/41',
  });
});

test('cancels only the run resolved for an active execution', async () => {
  const cancelledRunIds: number[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async findRun() {
        return { ...workflowRun, status: 'queued' };
      },
      async cancelRun(runId) {
        cancelledRunIds.push(runId);
      },
    }),
  );

  await expect(
    executor.cancel({ executionId: 'execution-1' }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    state: 'cancelling',
    externalUrl: 'https://github.com/example/repository/actions/runs/41',
  });
  expect(cancelledRunIds).toEqual([41]);
});

test('does not cancel a completed GitHub Actions run', async () => {
  const cancelledRunIds: number[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller({
      async findRun() {
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
    executor.cancel({ executionId: 'execution-1' }),
  ).resolves.toEqual({
    executionRef:
      'github-actions:liaowenjie15/deepauto-harness-sandbox:execution-1',
    state: 'completed',
    externalUrl: 'https://github.com/example/repository/actions/runs/41',
  });
  expect(cancelledRunIds).toEqual([]);
});
