import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { PrismaClient } from './generated/prisma/client';

export type JobQueue = Queue<{ jobId: string }>;

export type JobEnqueuer = {
  add(
    name: string,
    data: { jobId: string },
    options: { jobId: string },
  ): Promise<unknown>;
};

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

export function createJobQueue(name: string, connection: IORedis): JobQueue {
  return new Queue<{ jobId: string }>(name, { connection });
}

export async function enqueueJob(
  queue: JobEnqueuer,
  jobId: string,
  queueSequence = 0,
): Promise<void> {
  await queue.add('execute', { jobId }, { jobId: `${jobId}-${queueSequence}` });
}

export async function publishPendingOutboxEvents(
  prisma: PrismaClient,
  queue: JobEnqueuer,
  limit = 100,
  jobIds?: readonly string[],
): Promise<number> {
  const events = await prisma.outboxEvent.findMany({
    where: {
      publishedAt: null,
      jobId: jobIds ? { in: [...jobIds] } : undefined,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  for (const event of events) {
    await enqueueJob(queue, event.jobId, event.queueSequence);
    await prisma.outboxEvent.updateMany({
      where: { id: event.id, publishedAt: null },
      data: { publishedAt: new Date() },
    });
  }

  return events.length;
}

export async function tryClaimConversation(
  redis: IORedis,
  conversationKey: string,
  ownerId: string,
  ttlMilliseconds = 30_000,
): Promise<boolean> {
  const result = await redis.set(
    `deepauto:conversation:${conversationKey}`,
    ownerId,
    'PX',
    ttlMilliseconds,
    'NX',
  );
  return result === 'OK';
}

export async function releaseConversationClaim(
  redis: IORedis,
  conversationKey: string,
  ownerId: string,
): Promise<boolean> {
  const released = await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    `deepauto:conversation:${conversationKey}`,
    ownerId,
  );
  return released === 1;
}

export async function transferConversationClaim(
  redis: IORedis,
  conversationKey: string,
  ownerId: string,
  nextOwnerId: string,
  ttlMilliseconds: number,
): Promise<boolean> {
  const transferred = await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3]) else return nil end",
    1,
    `deepauto:conversation:${conversationKey}`,
    ownerId,
    nextOwnerId,
    ttlMilliseconds,
  );
  return transferred === 'OK';
}
