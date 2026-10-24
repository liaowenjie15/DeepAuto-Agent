import {
  type JobEnqueuer,
  type PrismaClient,
  publishPendingOutboxEvents,
  reconcileExpiredExecutionBootstraps,
} from '@deepauto/db';

const defaultIntervalMilliseconds = 1_000;

export type RetryOutboxPublisher = {
  publishOnce(): Promise<number>;
  stop(): void;
};

export type ExpiredBootstrapHandler = (executionId: string) => Promise<void>;

export function startRetryOutboxPublisher(
  prisma: PrismaClient,
  queue: JobEnqueuer,
  intervalMilliseconds = defaultIntervalMilliseconds,
  onExpiredBootstrap?: ExpiredBootstrapHandler,
): RetryOutboxPublisher {
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('Retry Outbox publisher interval must be positive');
  }

  let publishing = false;
  const publishOnce = async () => {
    if (publishing) return 0;
    publishing = true;
    try {
      const expiredExecutionIds =
        await reconcileExpiredExecutionBootstraps(prisma);
      for (const executionId of expiredExecutionIds) {
        await onExpiredBootstrap?.(executionId);
      }
      return await publishPendingOutboxEvents(prisma, queue);
    } finally {
      publishing = false;
    }
  };
  const timer = setInterval(() => {
    void publishOnce().catch(() => undefined);
  }, intervalMilliseconds);
  void publishOnce().catch(() => undefined);

  return { publishOnce, stop: () => clearInterval(timer) };
}
