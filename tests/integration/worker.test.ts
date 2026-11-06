import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  executeQueuedGitHubActionsJob,
  executeQueuedJob,
  releaseGitHubActionsExecutionConversation,
} from '../../apps/worker/src';
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
import {
  type CliHarnessRequest,
  ExecutorStartError,
} from '../../packages/runner-manager/src';

const environment = getTestEnvironment();
const prisma = createPrismaClient(environment.databaseUrl);
const redis = createRedisConnection(environment.redisUrl);
const testPrefix = `worker-integration-${crypto.randomUUID()}`;
const workspaceId = `${testPrefix}-workspace`;
const repositoryId = 'repository-1';

function input(
  overrides: Partial<Parameters<typeof createOrGetInvocationJob>[1]> = {},
) {
  return {
    source: 'github' as const,
    workspaceId,
    actorId: 'user-1',
    conversationKey: `${testPrefix}-conversation`,
    anchor: 'comment' as const,
    instruction: 'Run the controlled CLI task',
    sourceEventId: `${testPrefix}-event-1`,
    receivedAt: new Date('2026-10-20T00:00:00.000Z'),
    idempotencyKey: `${testPrefix}-job-1`,
    repositoryId,
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
    where: { invocation: { workspaceId } },
  });
  await prisma.invocation.deleteMany({
    where: { workspaceId },
  });
  await prisma.workspace.upsert({
    where: { id: workspaceId },
    create: { id: workspaceId },
    update: {},
  });
  await prisma.workspaceRepository.upsert({
    where: {
      workspaceId_providerRepositoryId: { workspaceId, providerRepositoryId: repositoryId },
    },
    create: { workspaceId, providerRepositoryId: repositoryId, enabled: true },
    update: { enabled: true },
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

  test('processes three Jobs in conversation order after the first Job fails', async () => {
    const first = await createOrGetInvocationJob(prisma, input());
    const second = await createOrGetInvocationJob(
      prisma,
      input({
        sourceEventId: `${testPrefix}-event-2`,
        idempotencyKey: `${testPrefix}-job-2`,
      }),
    );
    const third = await createOrGetInvocationJob(
      prisma,
      input({
        sourceEventId: `${testPrefix}-event-3`,
        idempotencyKey: `${testPrefix}-job-3`,
      }),
    );

    await expect(
      executeQueuedJob(workerInput(third.job.id), { prisma, redis }),
    ).resolves.toEqual({ status: 'deferred' });

    await expect(
      executeQueuedJob(workerInput(first.job.id), {
        prisma,
        redis,
        runHarness: async (request) => ({
          status: 'failed',
          reason: 'controlled first Job failure',
          events: [
            { type: 'started', attemptId: request.attemptId },
            {
              type: 'failed',
              attemptId: request.attemptId,
              reason: 'controlled first Job failure',
            },
          ],
          artifacts: {},
        }),
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    await expect(
      executeQueuedJob(workerInput(third.job.id), { prisma, redis }),
    ).resolves.toEqual({ status: 'deferred' });

    await expect(
      executeQueuedJob(workerInput(second.job.id), {
        prisma,
        redis,
        runHarness: completedHarnessResult,
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    await expect(
      executeQueuedJob(workerInput(third.job.id), {
        prisma,
        redis,
        runHarness: completedHarnessResult,
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(
      await prisma.job.findMany({
        where: { id: { in: [first.job.id, second.job.id, third.job.id] } },
        orderBy: { createdAt: 'asc' },
        select: { status: true },
      }),
    ).toEqual([
      { status: JobStatus.FAILED },
      { status: JobStatus.COMPLETED },
      { status: JobStatus.COMPLETED },
    ]);
  });

  test('dispatches GitHub Actions asynchronously and holds the conversation until callback release', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    let dispatchedExecutionId: string | undefined;

    const result = await executeQueuedGitHubActionsJob(
      {
        jobId: created.job.id,
        workerId: `${testPrefix}-worker`,
        callbackTtlMilliseconds: 60_000,
      },
      {
        prisma,
        redis,
        now: () => new Date('2026-10-20T00:00:00.000Z'),
        githubActionsExecutor: {
          isConfiguredForRepository: () => true,
          start: async ({ executionId }) => {
            dispatchedExecutionId = executionId;
            return { executionRef: `github-actions:sandbox:${executionId}` };
          },
          getStatus: async ({ executionId }) => ({
            executionRef: `github-actions:sandbox:${executionId}`,
            state: 'queued',
            externalRunId: 123n,
          }),
        },
      },
    );

    expect(result).toMatchObject({
      status: 'dispatched',
      executionRef: `github-actions:sandbox:${result.executionId}`,
    });
    expect(dispatchedExecutionId).toBe(result.executionId);
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { status: true } } },
      }),
    ).toEqual({
      status: JobStatus.RUNNING,
      attempts: [{ status: AttemptStatus.RUNNING }],
    });
    expect(
      await tryClaimConversation(
        redis,
        `${testPrefix}-conversation`,
        `${testPrefix}-next-worker`,
      ),
    ).toBe(false);
    expect(
      await releaseGitHubActionsExecutionConversation(
        result.executionId ?? '',
        { prisma, redis },
      ),
    ).toBe(true);
    expect(
      await tryClaimConversation(
        redis,
        `${testPrefix}-conversation`,
        `${testPrefix}-next-worker`,
      ),
    ).toBe(true);
  });

  test('marks an execution failed and releases the conversation when dispatch fails', async () => {
    const created = await createOrGetInvocationJob(prisma, input());

    const result = await executeQueuedGitHubActionsJob(
      {
        jobId: created.job.id,
        workerId: `${testPrefix}-worker`,
      },
      {
        prisma,
        redis,
        githubActionsExecutor: {
          isConfiguredForRepository: () => true,
          start: async () => {
            throw new Error('simulated workflow dispatch failure');
          },
        },
      },
    );

    expect(result.status).toBe('failed');
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: result.executionId },
        select: { status: true, reason: true },
      }),
    ).toEqual({
      status: 'FAILED',
      reason: 'GitHub Actions rejected the execution dispatch.',
    });
    expect(
      await tryClaimConversation(
        redis,
        `${testPrefix}-conversation`,
        `${testPrefix}-next-worker`,
      ),
    ).toBe(true);
  });

  test('retries a retryable GitHub Actions dispatch failure at most twice', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const retryableExecutor = {
      start: async () => {
        throw new ExecutorStartError(true, new Error('GitHub unavailable'));
      },
    };

    const first = await executeQueuedGitHubActionsJob(
      {
        jobId: created.job.id,
        workerId: `${testPrefix}-worker`,
      },
      {
        prisma,
        redis,
        githubActionsExecutor: {
          ...retryableExecutor,
          isConfiguredForRepository: () => true,
        },
      },
    );
    expect(first.status).toBe('retry_scheduled');
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { status: true } } },
      }),
    ).toEqual({
      status: JobStatus.QUEUED,
      attempts: [{ status: AttemptStatus.FAILED }],
    });

    const second = await executeQueuedGitHubActionsJob(
      {
        jobId: created.job.id,
        workerId: `${testPrefix}-worker`,
      },
      {
        prisma,
        redis,
        githubActionsExecutor: {
          ...retryableExecutor,
          isConfiguredForRepository: () => true,
        },
      },
    );
    expect(second.status).toBe('retry_scheduled');

    const third = await executeQueuedGitHubActionsJob(
      {
        jobId: created.job.id,
        workerId: `${testPrefix}-worker`,
      },
      {
        prisma,
        redis,
        githubActionsExecutor: {
          ...retryableExecutor,
          isConfiguredForRepository: () => true,
        },
      },
    );
    expect(third.status).toBe('failed');
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { status: true } } },
      }),
    ).toEqual({
      status: JobStatus.FAILED,
      attempts: [
        { status: AttemptStatus.FAILED },
        { status: AttemptStatus.FAILED },
        { status: AttemptStatus.FAILED },
      ],
    });
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

    expect(result.status).toBe('retry_scheduled');
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
      reason: 'Execution validation failed.',
      events: [],
    });
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, attempts: { select: { status: true } } },
      }),
    ).toEqual({
      status: JobStatus.QUEUED,
      attempts: [{ status: AttemptStatus.FAILED }],
    });
  });
});
