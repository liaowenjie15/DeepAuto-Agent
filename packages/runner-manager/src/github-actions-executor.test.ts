import { expect, test } from 'bun:test';
import type { GitHubWorkflowDispatch } from '@deepauto/github';
import { GitHubActionsExecutor } from './github-actions-executor';

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
