import type { JobEnqueuer, PrismaClient } from '@deepauto/db';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import {
  type ExecuteQueuedGitHubActionsJobDependencies,
  releaseGitHubActionsExecutionConversation,
} from './execute-job';
import {
  type GitHubActionsExecutionReconciler,
  startGitHubActionsExecutionReconciler,
} from './github-actions-execution-reconciler';
import {
  createGitHubActionsQueueProcessor,
  type GitHubActionsQueueProcessorOptions,
} from './github-actions-queue-processor';
import {
  type RetryOutboxPublisher,
  startRetryOutboxPublisher,
} from './retry-outbox-publisher';

type QueueHandle = JobEnqueuer & { close(): Promise<void> };
type WorkerHandle = { close(): Promise<void> };

type RuntimeFactories = {
  createQueue: (name: string, connection: IORedis) => QueueHandle;
  createWorker: (
    name: string,
    processor: ReturnType<typeof createGitHubActionsQueueProcessor>,
    connection: IORedis,
  ) => WorkerHandle;
  startRetryPublisher: (
    prisma: PrismaClient,
    queue: JobEnqueuer,
    intervalMilliseconds?: number,
    onExpiredBootstrap?: (executionId: string) => Promise<void>,
  ) => RetryOutboxPublisher;
  startExecutionReconciler: (
    dependencies: ExecuteQueuedGitHubActionsJobDependencies,
    intervalMilliseconds?: number,
  ) => GitHubActionsExecutionReconciler;
};

const defaultFactories: RuntimeFactories = {
  createQueue: (name, connection) => new Queue(name, { connection }),
  createWorker: (name, processor, connection) =>
    new Worker(name, processor, { connection }),
  startRetryPublisher: startRetryOutboxPublisher,
  startExecutionReconciler: startGitHubActionsExecutionReconciler,
};

export type GitHubActionsWorkerRuntimeOptions =
  GitHubActionsQueueProcessorOptions & {
    queueName: string;
    connection: IORedis;
    retryPublisherIntervalMilliseconds?: number;
  };

export type GitHubActionsWorkerRuntime = {
  close(): Promise<void>;
};

export function startGitHubActionsWorkerRuntime(
  options: GitHubActionsWorkerRuntimeOptions,
  dependencies: ExecuteQueuedGitHubActionsJobDependencies,
  factories: RuntimeFactories = defaultFactories,
): GitHubActionsWorkerRuntime {
  const queue = factories.createQueue(options.queueName, options.connection);
  const retryPublisher = factories.startRetryPublisher(
    dependencies.prisma,
    queue,
    options.retryPublisherIntervalMilliseconds,
    async (executionId) => {
      await releaseGitHubActionsExecutionConversation(
        executionId,
        dependencies,
      );
    },
  );
  const executionReconciler = factories.startExecutionReconciler(
    dependencies,
    options.retryPublisherIntervalMilliseconds,
  );
  const worker = factories.createWorker(
    options.queueName,
    createGitHubActionsQueueProcessor(options, dependencies),
    options.connection,
  );
  let closed = false;

  return {
    async close() {
      if (closed) return;
      closed = true;
      retryPublisher.stop();
      executionReconciler.stop();
      await worker.close();
      await queue.close();
    },
  };
}
