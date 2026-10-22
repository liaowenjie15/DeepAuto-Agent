import { expect, test } from 'bun:test';
import { DelayedError } from 'bullmq';
import {
  createGitHubActionsQueueProcessor,
  type GitHubActionsQueueData,
} from './github-actions-queue-processor';

test('delays a deferred Job instead of completing it', async () => {
  const movedTo: Array<{ timestamp: number; token: string | undefined }> = [];
  const processor = createGitHubActionsQueueProcessor(
    {
      workerId: 'worker-1',
      conversationDeferMilliseconds: 500,
      now: () => 1_000,
    },
    {} as never,
    async () => ({ status: 'deferred' }),
  );
  const job = {
    data: { jobId: 'job-1' } satisfies GitHubActionsQueueData,
    moveToDelayed: async (timestamp: number, token?: string) => {
      movedTo.push({ timestamp, token });
    },
  };

  await expect(processor(job as never, 'worker-token')).rejects.toBeInstanceOf(
    DelayedError,
  );
  expect(movedTo).toEqual([{ timestamp: 1_500, token: 'worker-token' }]);
});

test('completes terminal execution results without delaying the Job', async () => {
  let moved = false;
  const result = {
    status: 'dispatched' as const,
    attemptId: 'attempt-1',
    executionId: 'execution-1',
    executionRef: 'github-actions:sandbox:execution-1',
  };
  const processor = createGitHubActionsQueueProcessor(
    { workerId: 'worker-1' },
    {} as never,
    async () => result,
  );
  const job = {
    data: { jobId: 'job-1' } satisfies GitHubActionsQueueData,
    moveToDelayed: async () => {
      moved = true;
    },
  };

  await expect(processor(job as never)).resolves.toEqual(result);
  expect(moved).toBe(false);
});
