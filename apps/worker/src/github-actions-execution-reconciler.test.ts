import { expect, test } from 'bun:test';
import {
  resultForState,
  startGitHubActionsExecutionReconciler,
} from './github-actions-execution-reconciler';

test('rejects an invalid GitHub Actions reconciliation interval', () => {
  expect(() => startGitHubActionsExecutionReconciler({} as never, 0)).toThrow(
    'interval must be positive',
  );
});

test('does not synthesize a terminal callback for active or unknown runs', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');

  expect(resultForState('queued', now)).toBeNull();
  expect(resultForState('running', now)).toBeNull();
  expect(resultForState('cancelling', now)).toBeNull();
  expect(resultForState('unknown', now)).toBeNull();
});

test('synthesizes a callback only for a confirmed terminal run', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');

  expect(resultForState('completed', now)).toMatchObject({
    status: 'COMPLETED',
    retryable: false,
  });
  expect(resultForState('failed', now)).toMatchObject({
    status: 'FAILED',
    retryable: false,
  });
  expect(resultForState('cancelled', now)).toMatchObject({
    status: 'CANCELLED',
    retryable: false,
  });
});
