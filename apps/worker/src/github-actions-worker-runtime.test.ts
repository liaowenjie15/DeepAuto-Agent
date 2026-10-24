import { expect, test } from 'bun:test';
import { startGitHubActionsWorkerRuntime } from './github-actions-worker-runtime';

test('starts the Retry Outbox publisher before accepting execution jobs', async () => {
  const lifecycle: string[] = [];
  const runtime = startGitHubActionsWorkerRuntime(
    {
      queueName: 'deepauto-execute',
      connection: {} as never,
      workerId: 'worker-1',
      retryPublisherIntervalMilliseconds: 1_000,
    },
    {} as never,
    {
      createQueue: () => ({
        add: async () => undefined,
        close: async () => {
          lifecycle.push('queue-close');
        },
      }),
      startRetryPublisher: () => {
        lifecycle.push('publisher-start');
        return {
          publishOnce: async () => 0,
          stop: () => {
            lifecycle.push('publisher-stop');
          },
        };
      },
      startExecutionReconciler: () => {
        lifecycle.push('reconciler-start');
        return {
          reconcileOnce: async () => 0,
          stop: () => lifecycle.push('reconciler-stop'),
        };
      },
      createWorker: () => {
        lifecycle.push('worker-start');
        return {
          close: async () => {
            lifecycle.push('worker-close');
          },
        };
      },
    },
  );

  expect(lifecycle).toEqual([
    'publisher-start',
    'reconciler-start',
    'worker-start',
  ]);
  await runtime.close();
  await runtime.close();
  expect(lifecycle).toEqual([
    'publisher-start',
    'reconciler-start',
    'worker-start',
    'publisher-stop',
    'reconciler-stop',
    'worker-close',
    'queue-close',
  ]);
});
