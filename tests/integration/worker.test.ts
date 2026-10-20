import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CliHarnessRequest } from '../../packages/runner-manager/src';
import {
  AttemptStatus,
  createOrGetInvocationJob,
  createPrismaClient,
  createRedisConnection,
  getTestEnvironment,
  JobStatus,
  releaseConversationClaim,
  tryClaimConversation,
} from '../../packages/db/src';
import { executeQueuedJob } from '../../apps/worker/src';

const environment = getTestEnvironment();
const prisma = createPrismaClient(environment.databaseUrl);
const redis = createRedisConnection(environment.redisUrl);
const testPrefix = `worker-integration-${crypto.randomUUID()}`;

function input(
  overrides: Partial<Parameters<typeof createOrGetInvocationJob>[1]> = {},
) {
  return {
    source: 'github' as const,
    workspaceId: `${testPrefix}-workspace`,
    actorId: 'user-1',
    conversationKey: `${testPrefix}-conversation`,
    anchor: 'comment' as const,
    instruction: 'Run the controlled CLI task',
    sourceEventId: `${testPrefix}-event-1`,
    receivedAt: new Date('2026-10-20T00:00:00.000Z'),
    idempotencyKey: `${testPrefix}-job-1`,
    ...overrides,
  };
}

function workerInput(jobId: string) {
  return {
    jobId,
    workerId: `${testPrefix}-worker`,
    workspaceDir: process.cwd(),
    command: ['controlled-cli'],
    timeoutMilliseconds: 1_000,
    requiredArtifacts: ['test_result'] as const,
  };
}

function completedHarnessResult(request: CliHarnessRequest) {
  return {
    status: 'completed' as const,
    events: [
      { type: 'started' as const, attemptId: request.attemptId },
      {
        type: 'artifact' as const,
        attemptId: request.attemptId,
        name: 'test_result' as const,
        value: 'controlled checks passed',
      },
      { type: 'completed' as const, attemptId: request.attemptId },
    ],
    artifacts: { test_result: 'controlled checks passed' },
  };
}

beforeEach(async () => {
  await prisma.job.deleteMany({
    where: { invocation: { workspaceId: `${testPrefix}-workspace` } },
  });
  await prisma.invocation.deleteMany({
    where: { workspaceId: `${testPrefix}-workspace` },
  });
  await redis.del(`deepauto:conversation:${testPrefix}-conversation`);
});

afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});

describe('worker execution integration', () => {
  test('runs a claimed Job through the Harness and persists its terminal callback', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    let observedRequest: CliHarnessRequest | undefined;

    const result = await executeQueuedJob(workerInput(created.job.id), {
      prisma,
      redis,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
      runHarness: async (request) => {
        observedRequest = request;
        return completedHarnessResult(request);
      },
    });

    expect(result.status).toBe('completed');
    expect(observedRequest).toMatchObject({ jobId: created.job.id });
    expect(observedRequest?.attemptId).toBe(result.attemptId);
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { status: true } } },
      }),
    ).toEqual({
      status: JobStatus.COMPLETED,
      attempts: [{ status: AttemptStatus.COMPLETED }],
    });
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: result.executionId },
        select: {
          status: true,
          events: { orderBy: { sequence: 'asc' }, select: { type: true } },
          artifacts: { select: { name: true, value: true } },
        },
      }),
    ).toEqual({
      status: 'COMPLETED',
      events: [
        { type: 'STARTED' },
        { type: 'ARTIFACT' },
        { type: 'COMPLETED' },
      ],
      artifacts: [{ name: 'TEST_RESULT', value: 'controlled checks passed' }],
    });
    expect(
      await tryClaimConversation(
        redis,
        `${testPrefix}-conversation`,
        `${testPrefix}-next-worker`,
      ),
    ).toBe(true);
  });

  test('defers a queued Job while another worker owns its conversation', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const occupant = `${testPrefix}-occupant`;
    await tryClaimConversation(redis, `${testPrefix}-conversation`, occupant);

    const result = await executeQueuedJob(workerInput(created.job.id), {
      prisma,
      redis,
    });

    expect(result).toEqual({ status: 'deferred' });
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { id: true } } },
      }),
    ).toEqual({ status: JobStatus.QUEUED, attempts: [] });
    expect(
      await releaseConversationClaim(
        redis,
        `${testPrefix}-conversation`,
        occupant,
      ),
    ).toBe(true);
  });

  test('records a failed execution when the Harness throws before emitting a result', async () => {
    const created = await createOrGetInvocationJob(prisma, input());

    const result = await executeQueuedJob(workerInput(created.job.id), {
      prisma,
      redis,
      runHarness: async () => {
        throw new Error('simulated runner startup failure');
      },
    });

    expect(result.status).toBe('failed');
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: result.executionId },
        select: {
          status: true,
          reason: true,
          events: { select: { id: true } },
        },
      }),
    ).toEqual({
      status: 'FAILED',
      reason: 'CLI harness failed before producing an execution result',
      events: [],
    });
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { status: true } } },
      }),
    ).toEqual({
      status: JobStatus.FAILED,
      attempts: [{ status: AttemptStatus.FAILED }],
    });
  });
});
