import { expect, test } from 'bun:test';
import {
  GitHubRequestError,
  type GitHubWorkflowDispatch,
} from '@deepauto/github';
import {
  type ExecutorStartError,
  GitHubActionsExecutor,
} from './github-actions-executor';

test('dispatches the fixed sandbox workflow with only an execution reference', async () => {
  const dispatches: GitHubWorkflowDispatch[] = [];
  const executor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    {
      async dispatch(input) {
        dispatches.push(input);
      },
    },
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
        { async dispatch() {} },
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
    {
      async dispatch() {
        throw new GitHubRequestError('workflow dispatch', 503, 'Unavailable');
      },
    },
  );
  const terminalExecutor = new GitHubActionsExecutor(
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    {
      async dispatch() {
        throw new GitHubRequestError('workflow dispatch', 403, 'Forbidden');
      },
    },
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
