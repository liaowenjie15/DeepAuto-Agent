import { expect, test } from 'bun:test';
import { startGitHubActionsExecutionReconciler } from './github-actions-execution-reconciler';

test('rejects an invalid GitHub Actions reconciliation interval', () => {
  expect(() => startGitHubActionsExecutionReconciler({} as never, 0)).toThrow(
    'interval must be positive',
  );
});
