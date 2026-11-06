import {
  createExecutionControlQueue,
  type ExecutionControlEnqueuer,
  publishPendingExecutionControlEvents,
} from '@deepauto/db';
import { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import type { ExecutionCancellationControlDependencies } from './execution-control';
import {
  createExecutionControlQueueProcessor,
  type ExecutionControlQueueProcessorOptions,
} from './execution-control-queue-processor';

type QueueHandle = ExecutionControlEnqueuer & { close(): Promise<void> };
type WorkerHandle = { close(): Promise<void> };

type RuntimeFactories = {
  createQueue: (name: string, connection: IORedis) => QueueHandle;
  createWorker: (
    name: string,
    processor: ReturnType<typeof createExecutionControlQueueProcessor>,
    connection: IORedis,
  ) => WorkerHandle;
};

const defaultFactories: RuntimeFactories = {
  createQueue: (name, connection) =>
    createExecutionControlQueue(name, connection),
  createWorker: (name, processor, connection) =>
    new Worker(name, processor, { connection }),
};

const defaultPublisherIntervalMilliseconds = 1_000;

export type ExecutionControlWorkerRuntimeOptions =
  ExecutionControlQueueProcessorOptions & {
    queueName: string;
    connection: IORedis;
    publisherIntervalMilliseconds?: number;
  };

export type ExecutionControlWorkerRuntime = {
  close(): Promise<void>;
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function startExecutionControlWorkerRuntime(
  options: ExecutionControlWorkerRuntimeOptions,
  dependencies: ExecutionCancellationControlDependencies,
  factories: RuntimeFactories = defaultFactories,
): ExecutionControlWorkerRuntime {
  const publisherIntervalMilliseconds =
    options.publisherIntervalMilliseconds ??
    defaultPublisherIntervalMilliseconds;
  assertPositiveInteger(
    publisherIntervalMilliseconds,
    'Execution control publisher interval',
  );

  const queue = factories.createQueue(options.queueName, options.connection);
  let publishing = false;
  const publishOnce = async () => {
    if (publishing) return;
    publishing = true;
    try {
      await publishPendingExecutionControlEvents(dependencies.prisma, queue);
    } finally {
      publishing = false;
    }
  };
  const timer = setInterval(() => {
    void publishOnce().catch(() => undefined);
  }, publisherIntervalMilliseconds);
  void publishOnce().catch(() => undefined);

  const worker = factories.createWorker(
    options.queueName,
    createExecutionControlQueueProcessor(options, dependencies),
    options.connection,
  );
  let closed = false;

  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await worker.close();
      await queue.close();
    },
  };
}
