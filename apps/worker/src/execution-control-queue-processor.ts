import type { ExecutionControlQueueData } from '@deepauto/db';
import { DelayedError, type Processor } from 'bullmq';
import {
  type ExecutionCancellationControlDependencies,
  type ExecutionCancellationControlResult,
  processExecutionCancellationControl,
} from './execution-control';

const defaultReconciliationDelayMilliseconds = 5_000;

type ProcessExecutionCancellationControl =
  typeof processExecutionCancellationControl;

export type ExecutionControlQueueProcessorOptions = {
  reconciliationDelayMilliseconds?: number;
  maximumReconciliationAttempts?: number;
  now?: () => number;
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function createExecutionControlQueueProcessor(
  options: ExecutionControlQueueProcessorOptions,
  dependencies: ExecutionCancellationControlDependencies,
  process = processExecutionCancellationControl as ProcessExecutionCancellationControl,
): Processor<
  ExecutionControlQueueData,
  ExecutionCancellationControlResult,
  'execution-cancel'
> {
  const reconciliationDelayMilliseconds =
    options.reconciliationDelayMilliseconds ??
    defaultReconciliationDelayMilliseconds;
  assertPositiveInteger(
    reconciliationDelayMilliseconds,
    'Reconciliation delay',
  );
  const now = options.now ?? Date.now;

  return async (job, token) => {
    const result = await process(
      {
        outboxEventId: job.data.outboxEventId,
        maximumReconciliationAttempts: options.maximumReconciliationAttempts,
      },
      dependencies,
    );
    if (result.status !== 'retry') return result;

    await job.moveToDelayed(now() + reconciliationDelayMilliseconds, token);
    throw new DelayedError(
      'GitHub Actions cancellation is awaiting reconciliation',
    );
  };
}
