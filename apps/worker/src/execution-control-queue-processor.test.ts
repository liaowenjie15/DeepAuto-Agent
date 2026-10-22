import { expect, test } from 'bun:test';
import { DelayedError } from 'bullmq';
import { createExecutionControlQueueProcessor } from './execution-control-queue-processor';

test('delays an unresolved cancellation control event for reconciliation', async () => {
  const movedTo: Array<{ timestamp: number; token: string | undefined }> = [];
  const processor = createExecutionControlQueueProcessor(
    { reconciliationDelayMilliseconds: 500, now: () => 1_000 },
    {} as never,
    async () => ({ status: 'retry' }),
  );
  const job = {
    data: { outboxEventId: 'outbox-1' },
    moveToDelayed: async (timestamp: number, token?: string) => {
      movedTo.push({ timestamp, token });
    },
  };

  await expect(processor(job as never, 'worker-token')).rejects.toBeInstanceOf(
    DelayedError,
  );
  expect(movedTo).toEqual([{ timestamp: 1_500, token: 'worker-token' }]);
});

test('does not delay a terminal control result', async () => {
  let moved = false;
  const result = { status: 'completed' as const };
  const processor = createExecutionControlQueueProcessor(
    {},
    {} as never,
    async () => result,
  );
  const job = {
    data: { outboxEventId: 'outbox-1' },
    moveToDelayed: async () => {
      moved = true;
    },
  };

  await expect(processor(job as never)).resolves.toEqual(result);
  expect(moved).toBe(false);
});
