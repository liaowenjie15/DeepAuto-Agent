import {
  type JobEnqueuer,
  type PrismaClient,
  publishPendingOutboxEvents,
} from '@deepauto/db';

const defaultIntervalMilliseconds = 1_000;

export type RetryOutboxPublisher = {
  publishOnce(): Promise<number>;
  stop(): void;
};

export function startRetryOutboxPublisher(
  prisma: PrismaClient,
  queue: JobEnqueuer,
  intervalMilliseconds = defaultIntervalMilliseconds,
): RetryOutboxPublisher {
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('Retry Outbox publisher interval must be positive');
  }

  let publishing = false;
  const publishOnce = async () => {
    if (publishing) return 0;
    publishing = true;
    try {
      return await publishPendingOutboxEvents(prisma, queue);
    } finally {
      publishing = false;
    }
  };
  const timer = setInterval(() => {
    void publishOnce();
  }, intervalMilliseconds);
  void publishOnce();

  return { publishOnce, stop: () => clearInterval(timer) };
}
