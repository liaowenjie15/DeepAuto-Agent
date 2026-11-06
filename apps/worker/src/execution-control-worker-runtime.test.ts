import { expect, test } from 'bun:test';
import { startExecutionControlWorkerRuntime } from './execution-control-worker-runtime';

test('starts and stops the execution control queue worker', async () => {
  const lifecycle: string[] = [];
  const runtime = startExecutionControlWorkerRuntime(
    {
      queueName: 'deepauto-execution-control',
      connection: {} as never,
      publisherIntervalMilliseconds: 1_000,
    },
    {} as never,
    {
      createQueue: () => ({
        add: async () => undefined,
        close: async () => {
          lifecycle.push('queue-close');
        },
      }),
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

  expect(lifecycle).toEqual(['worker-start']);
  await runtime.close();
  await runtime.close();
  expect(lifecycle).toEqual(['worker-start', 'worker-close', 'queue-close']);
});
