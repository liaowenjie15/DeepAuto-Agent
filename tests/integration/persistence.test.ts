import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ExecutionEvent } from '../../packages/contracts/src';
import {
  AttemptStatus,
  acceptExecutionCallback,
  acceptExecutionCallbackByExecutionId,
  authorizeInboundInvocation,
  beginJobAttempt,
  CredentialProvider,
  consumeCredentialClaim,
  createJobQueue,
  createOrGetInvocationJob,
  createPrismaClient,
  createRedisConnection,
  type ExecutionControlEnqueuer,
  enqueueJob,
  finishJobAttempt,
  getActiveExecutionBootstrap,
  getExecutionCancellationControl,
  getTestEnvironment,
  issueCredentialClaim,
  type JobEnqueuer,
  JobStatus,
  OutboxEventKind,
  publishPendingExecutionControlEvents,
  publishPendingOutboxEvents,
  recordExecutionCancellationAttempt,
  recordExternalExecutionTerminalStatus,
  recoverExpiredJobAttempts,
  releaseConversationClaim,
  requestJobCancellation,
  requeueFailedJob,
  startExecution,
  tryClaimConversation,
} from '../../packages/db/src';

const environment = getTestEnvironment();
const prisma = createPrismaClient(environment.databaseUrl);
const redis = createRedisConnection(environment.redisUrl);
const testPrefix = `integration-${crypto.randomUUID()}`;

function createTestQueue(name: string) {
  return createJobQueue(name, createRedisConnection(environment.redisUrl));
}

function input(
  overrides: Partial<Parameters<typeof createOrGetInvocationJob>[1]> = {},
) {
  return {
    source: 'feishu' as const,
    workspaceId: `${testPrefix}-workspace`,
    actorId: 'user-1',
    conversationKey: `${testPrefix}-conversation`,
    anchor: 'message' as const,
    instruction: 'Summarize this thread',
    sourceEventId: `${testPrefix}-event-1`,
    receivedAt: new Date('2026-10-20T00:00:00.000Z'),
    idempotencyKey: `${testPrefix}-job-1`,
    ...overrides,
  };
}

function completedExecutionEvents(attemptId: string): ExecutionEvent[] {
  return [
    { type: 'started', attemptId },
    {
      type: 'artifact',
      attemptId,
      name: 'test_result',
      value: 'bun test: 15 passed',
    },
    { type: 'completed', attemptId },
  ];
}

beforeEach(async () => {
  await prisma.auditEvent.deleteMany({
    where: { workspaceId: `${testPrefix}-workspace` },
  });
  await prisma.credentialClaim.deleteMany({
    where: { workspaceId: `${testPrefix}-workspace` },
  });
  await prisma.job.deleteMany({
    where: { invocation: { workspaceId: `${testPrefix}-workspace` } },
  });
  await prisma.invocation.deleteMany({
    where: { workspaceId: `${testPrefix}-workspace` },
  });
  await prisma.workspaceRepository.deleteMany({
    where: { workspaceId: `${testPrefix}-workspace` },
  });
  await prisma.workspaceMember.deleteMany({
    where: { workspaceId: `${testPrefix}-workspace` },
  });
  await prisma.workspace.deleteMany({
    where: { id: `${testPrefix}-workspace` },
  });
  await redis.del(
    `deepauto:conversation:${testPrefix}-conversation`,
    `deepauto:conversation:${testPrefix}-other-conversation`,
  );
});

afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});

describe('persistence and queue integration', () => {
  test('authorizes only mapped members and allowlisted GitHub repositories', async () => {
    await prisma.workspace.create({ data: { id: `${testPrefix}-workspace` } });
    const member = await prisma.workspaceMember.create({
      data: {
        workspaceId: `${testPrefix}-workspace`,
        githubUserId: 'github-user-1',
      },
    });
    await prisma.workspaceRepository.create({
      data: {
        workspaceId: `${testPrefix}-workspace`,
        providerRepositoryId: 'repository-1',
      },
    });

    const invocation = {
      source: 'github' as const,
      workspaceId: `${testPrefix}-workspace`,
      actorId: 'untrusted-provider-id',
      providerActorId: 'github-user-1',
      repositoryId: 'repository-1',
      conversationKey: `${testPrefix}-conversation`,
      anchor: 'pull-request' as const,
      instruction: 'Fix the test',
      sourceEventId: `${testPrefix}-delivery-1`,
      idempotencyKey: `${testPrefix}-comment-1`,
      receivedAt: '2026-10-20T00:00:00.000Z',
    };

    expect(await authorizeInboundInvocation(prisma, invocation)).toMatchObject({
      actorId: member.id,
      workspaceId: `${testPrefix}-workspace`,
    });
    expect(
      await authorizeInboundInvocation(prisma, {
        ...invocation,
        repositoryId: 'not-allowlisted',
      }),
    ).toBeNull();
    expect(
      await authorizeInboundInvocation(prisma, {
        ...invocation,
        providerActorId: 'unknown-user',
      }),
    ).toBeNull();
  });

  test('creates one invocation and one Job when a source event is delivered twice', async () => {
    const first = await createOrGetInvocationJob(prisma, input());
    const duplicate = await createOrGetInvocationJob(prisma, input());

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(
      await prisma.invocation.count({
        where: { workspaceId: `${testPrefix}-workspace` },
      }),
    ).toBe(1);
    expect(
      await prisma.job.count({
        where: { idempotencyKey: `${testPrefix}-job-1` },
      }),
    ).toBe(1);
  });

  test('uses the business idempotency key when a retried delivery has a new source event ID', async () => {
    const first = await createOrGetInvocationJob(prisma, input());
    const duplicate = await createOrGetInvocationJob(
      prisma,
      input({ sourceEventId: `${testPrefix}-event-2` }),
    );

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(
      await prisma.invocation.count({
        where: { workspaceId: `${testPrefix}-workspace` },
      }),
    ).toBe(1);
  });

  test('cancels a queued Job without creating a control Outbox event', async () => {
    const created = await createOrGetInvocationJob(prisma, input());

    expect(
      await requestJobCancellation(prisma, {
        jobId: created.job.id,
        requestedByActorId: 'user-1',
        now: new Date('2026-10-20T00:00:00.000Z'),
      }),
    ).toEqual({ accepted: true, state: 'cancelled' });
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, cancelledAt: true },
      }),
    ).toEqual({
      status: JobStatus.CANCELLED,
      cancelledAt: new Date('2026-10-20T00:00:00.000Z'),
    });
    expect(
      await prisma.outboxEvent.count({
        where: {
          jobId: created.job.id,
          kind: OutboxEventKind.EXECUTION_CANCEL,
        },
      }),
    ).toBe(0);
    expect(await beginJobAttempt(prisma, created.job.id)).toBeNull();
  });

  test('deduplicates BullMQ enqueueing by the persisted Job ID', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const queue = createTestQueue(`${testPrefix}-queue`);

    try {
      await enqueueJob(queue, created.job.id);
      await enqueueJob(queue, created.job.id);
      expect(
        await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized'),
      ).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  test('retains an outbox event when enqueueing fails, then publishes it once after recovery', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const unavailableQueue: JobEnqueuer = {
      add: () => Promise.reject(new Error('simulated enqueue failure')),
    };

    await expect(
      publishPendingOutboxEvents(prisma, unavailableQueue),
    ).rejects.toThrow('simulated enqueue failure');
    expect(
      await prisma.outboxEvent.count({
        where: { jobId: created.job.id, publishedAt: null },
      }),
    ).toBe(1);

    const recoveredQueue = createTestQueue(`${testPrefix}-outbox-queue`);
    try {
      expect(
        await publishPendingOutboxEvents(prisma, recoveredQueue, 100, [
          created.job.id,
        ]),
      ).toBe(1);
      expect(
        await publishPendingOutboxEvents(prisma, recoveredQueue, 100, [
          created.job.id,
        ]),
      ).toBe(0);
      expect(
        await recoveredQueue.getJobCountByTypes(
          'waiting',
          'delayed',
          'prioritized',
        ),
      ).toBe(1);
    } finally {
      await recoveredQueue.obliterate({ force: true });
      await recoveredQueue.close();
    }
  });

  test('requeues an expired attempt with a new outbox sequence', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);

    expect(attempt).not.toBeNull();
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-21T00:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    await prisma.jobAttempt.update({
      where: { id: attempt?.id },
      data: { startedAt: new Date('2026-10-19T00:00:00.000Z') },
    });

    expect(
      await recoverExpiredJobAttempts(
        prisma,
        new Date('2026-10-20T00:00:00.000Z'),
      ),
    ).toEqual([created.job.id]);
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true },
      }),
    ).toEqual({ status: JobStatus.QUEUED });
    expect(
      await prisma.jobAttempt.findUniqueOrThrow({
        where: { id: attempt?.id },
        select: { status: true },
      }),
    ).toEqual({ status: AttemptStatus.FAILED });
    expect(
      await prisma.outboxEvent.count({
        where: { jobId: created.job.id, publishedAt: null },
      }),
    ).toBe(2);
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: { status: true, reason: true, finishedAt: true },
      }),
    ).toEqual({
      status: 'TIMED_OUT',
      reason: 'Job attempt lease expired',
      finishedAt: expect.any(Date),
    });
  });

  test('does not recover a running execution while cancellation is requested', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-21T00:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    await prisma.jobAttempt.update({
      where: { id: attempt?.id },
      data: { startedAt: new Date('2026-10-19T00:00:00.000Z') },
    });

    await requestJobCancellation(prisma, {
      jobId: created.job.id,
      requestedByActorId: 'user-1',
      now: new Date('2026-10-20T00:01:00.000Z'),
    });

    expect(
      await recoverExpiredJobAttempts(
        prisma,
        new Date('2026-10-20T00:02:00.000Z'),
      ),
    ).toEqual([]);
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: {
          status: true,
          cancellationRequest: { select: { status: true } },
        },
      }),
    ).toEqual({
      status: 'RUNNING',
      cancellationRequest: { status: 'REQUESTED' },
    });
  });

  test('accepts one terminal callback and does not notify twice', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);

    expect(attempt).not.toBeNull();
    expect(
      await finishJobAttempt(
        prisma,
        attempt?.id ?? '',
        AttemptStatus.COMPLETED,
      ),
    ).toEqual({ accepted: true, shouldNotify: true });
    expect(
      await finishJobAttempt(
        prisma,
        attempt?.id ?? '',
        AttemptStatus.COMPLETED,
      ),
    ).toEqual({ accepted: false, shouldNotify: false });
  });

  test('does not let an old attempt callback overwrite the retried attempt', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const firstAttempt = await beginJobAttempt(prisma, created.job.id);

    expect(firstAttempt).not.toBeNull();
    await finishJobAttempt(
      prisma,
      firstAttempt?.id ?? '',
      AttemptStatus.FAILED,
    );
    expect(await requeueFailedJob(prisma, created.job.id)).toBe(true);
    const secondAttempt = await beginJobAttempt(prisma, created.job.id);

    expect(secondAttempt).not.toBeNull();
    expect(
      await finishJobAttempt(
        prisma,
        firstAttempt?.id ?? '',
        AttemptStatus.COMPLETED,
      ),
    ).toEqual({ accepted: false, shouldNotify: false });
    expect(
      await finishJobAttempt(
        prisma,
        secondAttempt?.id ?? '',
        AttemptStatus.COMPLETED,
      ),
    ).toEqual({ accepted: true, shouldNotify: true });
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true, currentAttemptNumber: true },
      }),
    ).toEqual({ status: JobStatus.COMPLETED, currentAttemptNumber: 2 });
  });

  test('allows either cancellation or completion to win, and cancellation does not touch the next Job', async () => {
    const first = await createOrGetInvocationJob(prisma, input());
    const second = await createOrGetInvocationJob(
      prisma,
      input({
        sourceEventId: `${testPrefix}-event-2`,
        idempotencyKey: `${testPrefix}-job-2`,
      }),
    );
    const attempt = await beginJobAttempt(prisma, first.job.id);

    expect(attempt).not.toBeNull();
    const [cancellation, completed] = await Promise.all([
      requestJobCancellation(prisma, {
        jobId: first.job.id,
        requestedByActorId: 'user-1',
      }),
      finishJobAttempt(prisma, attempt?.id ?? '', AttemptStatus.COMPLETED),
    ]);
    const cancelled =
      cancellation.accepted && cancellation.state === 'cancelled';

    expect(Number(cancelled) + Number(completed.accepted)).toBe(1);
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: first.job.id },
        select: { status: true },
      }),
    ).toSatisfy((job) =>
      [JobStatus.CANCELLED, JobStatus.COMPLETED].includes(job.status),
    );
    if (cancelled) {
      expect(
        await prisma.jobAttempt.findUniqueOrThrow({
          where: { id: attempt?.id },
          select: { status: true },
        }),
      ).toEqual({ status: AttemptStatus.CANCELLED });
    }
    expect(await beginJobAttempt(prisma, second.job.id)).not.toBeNull();
  });

  test('consumes a credential claim once for its active actor and attempt without auditing its reference', async () => {
    await prisma.workspace.create({ data: { id: `${testPrefix}-workspace` } });
    const member = await prisma.workspaceMember.create({
      data: {
        workspaceId: `${testPrefix}-workspace`,
        larkOpenId: 'ou-user',
      },
    });
    const created = await createOrGetInvocationJob(
      prisma,
      input({ actorId: member.id }),
    );
    const attempt = await beginJobAttempt(prisma, created.job.id);

    expect(attempt).not.toBeNull();
    const claim = await issueCredentialClaim(
      prisma,
      {
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: attempt?.id ?? '',
        provider: CredentialProvider.LARK_USER,
        credentialReference: 'vault://credential/opaque-reference',
        expiresAt: new Date('2026-10-21T00:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );

    expect(
      await consumeCredentialClaim(prisma, {
        claimId: claim.id,
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: attempt?.id ?? '',
        now: new Date('2026-10-20T01:00:00.000Z'),
      }),
    ).toEqual({ credentialReference: 'vault://credential/opaque-reference' });
    expect(
      await consumeCredentialClaim(prisma, {
        claimId: claim.id,
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: attempt?.id ?? '',
        now: new Date('2026-10-20T01:00:01.000Z'),
      }),
    ).toBeNull();
    const auditEvents = await prisma.auditEvent.findMany({
      where: { attemptId: attempt?.id },
      select: { metadata: true },
    });
    expect(JSON.stringify(auditEvents)).not.toContain(
      'vault://credential/opaque-reference',
    );
  });

  test('rejects expired, replayed, and incorrectly bound credential claims', async () => {
    await prisma.workspace.create({ data: { id: `${testPrefix}-workspace` } });
    const member = await prisma.workspaceMember.create({
      data: {
        workspaceId: `${testPrefix}-workspace`,
        larkOpenId: 'ou-user',
      },
    });
    const created = await createOrGetInvocationJob(
      prisma,
      input({ actorId: member.id }),
    );
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const claim = await issueCredentialClaim(
      prisma,
      {
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: attempt?.id ?? '',
        provider: CredentialProvider.LARK_USER,
        credentialReference: 'vault://credential/bound-reference',
        expiresAt: new Date('2026-10-20T00:05:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );

    expect(
      await consumeCredentialClaim(prisma, {
        claimId: claim.id,
        workspaceId: `${testPrefix}-workspace`,
        actorId: 'other-member',
        attemptId: attempt?.id ?? '',
        now: new Date('2026-10-20T00:01:00.000Z'),
      }),
    ).toBeNull();
    expect(
      await consumeCredentialClaim(prisma, {
        claimId: claim.id,
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: 'other-attempt',
        now: new Date('2026-10-20T00:01:00.000Z'),
      }),
    ).toBeNull();
    expect(
      await consumeCredentialClaim(prisma, {
        claimId: claim.id,
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: attempt?.id ?? '',
        now: new Date('2026-10-20T00:05:00.000Z'),
      }),
    ).toBeNull();

    await expect(
      issueCredentialClaim(
        prisma,
        {
          workspaceId: `${testPrefix}-workspace`,
          actorId: member.id,
          attemptId: attempt?.id ?? '',
          provider: CredentialProvider.LARK_USER,
          credentialReference: 'vault://credential/expired-reference',
          expiresAt: new Date('2026-10-20T00:00:00.000Z'),
        },
        new Date('2026-10-20T00:00:00.000Z'),
      ),
    ).rejects.toThrow('expiry must be in the future');
  });

  test('allows exactly one concurrent credential claim consumer', async () => {
    await prisma.workspace.create({ data: { id: `${testPrefix}-workspace` } });
    const member = await prisma.workspaceMember.create({
      data: {
        workspaceId: `${testPrefix}-workspace`,
        larkOpenId: 'ou-user',
      },
    });
    const created = await createOrGetInvocationJob(
      prisma,
      input({ actorId: member.id }),
    );
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const claim = await issueCredentialClaim(
      prisma,
      {
        workspaceId: `${testPrefix}-workspace`,
        actorId: member.id,
        attemptId: attempt?.id ?? '',
        provider: CredentialProvider.LARK_USER,
        credentialReference: 'vault://credential/concurrent-reference',
        expiresAt: new Date('2026-10-21T00:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    const claimInput = {
      claimId: claim.id,
      workspaceId: `${testPrefix}-workspace`,
      actorId: member.id,
      attemptId: attempt?.id ?? '',
      now: new Date('2026-10-20T01:00:00.000Z'),
    };

    const results = await Promise.all([
      consumeCredentialClaim(prisma, claimInput),
      consumeCredentialClaim(prisma, claimInput),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  test('persists a task-bound execution callback and trusted artifacts atomically', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);
    expect(attempt).not.toBeNull();

    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    const result = await acceptExecutionCallback(prisma, {
      attemptId: attempt?.id ?? '',
      callbackClaimId: execution.callbackClaim?.id ?? '',
      status: 'COMPLETED',
      events: completedExecutionEvents(attempt?.id ?? ''),
      now: new Date('2026-10-20T00:01:00.000Z'),
    });

    expect(result).toEqual({ accepted: true });
    const persisted = await prisma.execution.findUniqueOrThrow({
      where: { id: execution.id },
      include: { events: { orderBy: { sequence: 'asc' } }, artifacts: true },
    });
    expect({ status: persisted.status, reason: persisted.reason }).toEqual({
      status: 'COMPLETED',
      reason: null,
    });
    expect(persisted.events.map((event) => event.type)).toEqual([
      'STARTED',
      'ARTIFACT',
      'COMPLETED',
    ]);
    expect(persisted.artifacts).toEqual([
      expect.objectContaining({
        name: 'TEST_RESULT',
        value: 'bun test: 15 passed',
      }),
    ]);
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true },
      }),
    ).toEqual({ status: JobStatus.COMPLETED });
    expect(
      await prisma.jobAttempt.findUniqueOrThrow({
        where: { id: attempt?.id },
        select: { status: true },
      }),
    ).toEqual({ status: AttemptStatus.COMPLETED });
    expect(
      await prisma.executionCallbackClaim.findUniqueOrThrow({
        where: { id: execution.callbackClaim?.id },
        select: { usedAt: true },
      }),
    ).toEqual({ usedAt: new Date('2026-10-20T00:01:00.000Z') });
  });

  test('returns only active execution context and consumes its callback claim internally', async () => {
    const created = await createOrGetInvocationJob(
      prisma,
      input({ instruction: 'change fixture before to after' }),
    );
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );

    expect(
      await getActiveExecutionBootstrap(
        prisma,
        execution.id,
        new Date('2026-10-20T00:01:00.000Z'),
      ),
    ).toEqual({
      executionId: execution.id,
      attemptId: attempt?.id,
      instruction: 'change fixture before to after',
    });
    expect(
      await getActiveExecutionBootstrap(
        prisma,
        execution.id,
        new Date('2026-10-20T01:00:00.000Z'),
      ),
    ).toBeNull();

    expect(
      await acceptExecutionCallbackByExecutionId(prisma, {
        executionId: execution.id,
        status: 'COMPLETED',
        events: completedExecutionEvents(attempt?.id ?? ''),
        now: new Date('2026-10-20T00:01:00.000Z'),
      }),
    ).toEqual({ accepted: true });
    expect(
      await prisma.executionCallbackClaim.findUniqueOrThrow({
        where: { id: execution.callbackClaim?.id },
        select: { usedAt: true },
      }),
    ).toEqual({ usedAt: new Date('2026-10-20T00:01:00.000Z') });
  });

  test('rejects forged attempts, expired callback claims, and concurrent callback replays', async () => {
    const first = await createOrGetInvocationJob(prisma, input());
    const second = await createOrGetInvocationJob(
      prisma,
      input({
        sourceEventId: `${testPrefix}-execution-event-2`,
        idempotencyKey: `${testPrefix}-execution-job-2`,
      }),
    );
    const firstAttempt = await beginJobAttempt(prisma, first.job.id);
    const secondAttempt = await beginJobAttempt(prisma, second.job.id);
    expect(firstAttempt).not.toBeNull();
    expect(secondAttempt).not.toBeNull();

    const execution = await startExecution(
      prisma,
      {
        attemptId: firstAttempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    const callbackClaimId = execution.callbackClaim?.id ?? '';

    expect(
      await acceptExecutionCallback(prisma, {
        attemptId: secondAttempt?.id ?? '',
        callbackClaimId,
        status: 'COMPLETED',
        events: completedExecutionEvents(secondAttempt?.id ?? ''),
        now: new Date('2026-10-20T00:01:00.000Z'),
      }),
    ).toEqual({ accepted: false });
    expect(
      await acceptExecutionCallback(prisma, {
        attemptId: firstAttempt?.id ?? '',
        callbackClaimId,
        status: 'COMPLETED',
        events: completedExecutionEvents(firstAttempt?.id ?? ''),
        now: new Date('2026-10-20T01:00:00.000Z'),
      }),
    ).toEqual({ accepted: false });

    const callback = {
      attemptId: firstAttempt?.id ?? '',
      callbackClaimId,
      status: 'COMPLETED' as const,
      events: completedExecutionEvents(firstAttempt?.id ?? ''),
      now: new Date('2026-10-20T00:01:00.000Z'),
    };
    const replayResults = await Promise.all([
      acceptExecutionCallback(prisma, callback),
      acceptExecutionCallback(prisma, callback),
    ]);

    expect(replayResults.filter((result) => result.accepted)).toHaveLength(1);
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: { status: true, events: { select: { id: true } } },
      }),
    ).toEqual({
      status: 'COMPLETED',
      events: [
        { id: expect.any(String) },
        { id: expect.any(String) },
        { id: expect.any(String) },
      ],
    });
    expect(
      await prisma.jobAttempt.findUniqueOrThrow({
        where: { id: secondAttempt?.id },
        select: { status: true },
      }),
    ).toEqual({ status: AttemptStatus.RUNNING });
  });

  test('records one running-execution cancellation intent without invalidating its callback', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    const executionQueueOutbox = await prisma.outboxEvent.findUniqueOrThrow({
      where: { dedupeKey: `job:${created.job.id}:enqueue` },
      select: { id: true },
    });

    expect(
      await requestJobCancellation(prisma, {
        jobId: created.job.id,
        requestedByActorId: 'user-1',
        now: new Date('2026-10-20T00:01:00.000Z'),
      }),
    ).toEqual({
      accepted: true,
      state: 'requested',
      executionId: execution.id,
    });
    expect(
      await requestJobCancellation(prisma, {
        jobId: created.job.id,
        requestedByActorId: 'user-1',
        now: new Date('2026-10-20T00:02:00.000Z'),
      }),
    ).toEqual({
      accepted: true,
      state: 'already_requested',
      executionId: execution.id,
    });
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: {
          status: true,
          callbackClaim: { select: { usedAt: true } },
          cancellationRequest: {
            select: { requestedByActorId: true, status: true },
          },
        },
      }),
    ).toEqual({
      status: 'RUNNING',
      callbackClaim: { usedAt: null },
      cancellationRequest: {
        requestedByActorId: 'user-1',
        status: 'REQUESTED',
      },
    });
    expect(
      await prisma.outboxEvent.count({
        where: {
          jobId: created.job.id,
          kind: OutboxEventKind.EXECUTION_CANCEL,
          publishedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await getActiveExecutionBootstrap(
        prisma,
        execution.id,
        new Date('2026-10-20T00:01:00.000Z'),
      ),
    ).toBeNull();
    await prisma.outboxEvent.updateMany({
      where: { id: executionQueueOutbox.id },
      data: { publishedAt: new Date('2026-10-20T00:02:00.000Z') },
    });
    const unavailableQueue: JobEnqueuer = {
      add: () =>
        Promise.reject(new Error('control events must not use execute')),
    };
    expect(
      await publishPendingOutboxEvents(prisma, unavailableQueue, 100, [
        created.job.id,
      ]),
    ).toBe(0);
    expect(
      await acceptExecutionCallback(prisma, {
        attemptId: attempt?.id ?? '',
        callbackClaimId: execution.callbackClaim?.id ?? '',
        status: 'COMPLETED',
        events: completedExecutionEvents(attempt?.id ?? ''),
        now: new Date('2026-10-20T00:01:00.000Z'),
      }),
    ).toEqual({ accepted: true });
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: {
          status: true,
          callbackClaim: { select: { usedAt: true } },
          cancellationRequest: { select: { status: true } },
        },
      }),
    ).toEqual({
      status: 'COMPLETED',
      callbackClaim: { usedAt: new Date('2026-10-20T00:01:00.000Z') },
      cancellationRequest: { status: 'SUPERSEDED' },
    });
  });

  test('publishes cancellation control work and records the verified external terminal state', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );
    await requestJobCancellation(prisma, {
      jobId: created.job.id,
      requestedByActorId: 'user-1',
      now: new Date('2026-10-20T00:01:00.000Z'),
    });

    const published: Array<{
      name: string;
      data: { outboxEventId: string };
      jobId: string;
    }> = [];
    const controlQueue: ExecutionControlEnqueuer = {
      add: async (name, data, options) => {
        published.push({ name, data, jobId: options.jobId });
      },
    };
    expect(
      await publishPendingExecutionControlEvents(prisma, controlQueue),
    ).toBe(1);
    expect(
      await publishPendingExecutionControlEvents(prisma, controlQueue),
    ).toBe(0);
    expect(published).toEqual([
      {
        name: 'execution-cancel',
        data: { outboxEventId: expect.any(String) },
        jobId: expect.stringMatching(/^execution-control:/),
      },
    ]);

    const control = await getExecutionCancellationControl(
      prisma,
      published[0]?.data.outboxEventId ?? '',
    );
    expect(control).toMatchObject({
      executionId: execution.id,
      attemptCount: 0,
      status: 'REQUESTED',
      externalRunId: null,
    });
    expect(
      await recordExecutionCancellationAttempt(prisma, {
        cancellationRequestId: control?.cancellationRequestId ?? '',
        executionId: execution.id,
        status: 'DISPATCHED',
        externalRunId: 42n,
        externalUrl: 'https://github.com/example/repository/actions/runs/42',
        lastError: null,
        now: new Date('2026-10-20T00:02:00.000Z'),
      }),
    ).toBe(true);
    expect(
      await recordExternalExecutionTerminalStatus(prisma, {
        executionId: execution.id,
        status: 'CANCELLED',
        reason: 'GitHub Actions status reconciliation observed CANCELLED',
        now: new Date('2026-10-20T00:03:00.000Z'),
      }),
    ).toBe(true);
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: {
          status: true,
          externalRunId: true,
          externalUrl: true,
          callbackClaim: { select: { usedAt: true } },
          cancellationRequest: { select: { status: true, attemptCount: true } },
        },
      }),
    ).toEqual({
      status: 'CANCELLED',
      externalRunId: 42n,
      externalUrl: 'https://github.com/example/repository/actions/runs/42',
      callbackClaim: { usedAt: new Date('2026-10-20T00:03:00.000Z') },
      cancellationRequest: { status: 'COMPLETED', attemptCount: 1 },
    });
  });

  test('confirms a cancellation intent only when the execution callback is cancelled', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );

    await requestJobCancellation(prisma, {
      jobId: created.job.id,
      requestedByActorId: 'user-1',
      now: new Date('2026-10-20T00:01:00.000Z'),
    });
    expect(
      await acceptExecutionCallback(prisma, {
        attemptId: attempt?.id ?? '',
        callbackClaimId: execution.callbackClaim?.id ?? '',
        status: 'CANCELLED',
        events: [{ type: 'started', attemptId: attempt?.id ?? '' }],
        now: new Date('2026-10-20T00:02:00.000Z'),
      }),
    ).toEqual({ accepted: true });
    expect(
      await prisma.job.findUniqueOrThrow({
        where: { id: created.job.id },
        select: { status: true },
      }),
    ).toEqual({ status: JobStatus.CANCELLED });
    expect(
      await prisma.executionCancellationRequest.findUniqueOrThrow({
        where: { executionId: execution.id },
        select: { status: true },
      }),
    ).toEqual({ status: 'COMPLETED' });
  });

  test('accepts only one callback terminal after a cancellation intent', async () => {
    const created = await createOrGetInvocationJob(prisma, input());
    const attempt = await beginJobAttempt(prisma, created.job.id);
    const execution = await startExecution(
      prisma,
      {
        attemptId: attempt?.id ?? '',
        callbackExpiresAt: new Date('2026-10-20T01:00:00.000Z'),
      },
      new Date('2026-10-20T00:00:00.000Z'),
    );

    await requestJobCancellation(prisma, {
      jobId: created.job.id,
      requestedByActorId: 'user-1',
      now: new Date('2026-10-20T00:01:00.000Z'),
    });

    const callbacks = await Promise.all([
      acceptExecutionCallback(prisma, {
        attemptId: attempt?.id ?? '',
        callbackClaimId: execution.callbackClaim?.id ?? '',
        status: 'COMPLETED',
        events: completedExecutionEvents(attempt?.id ?? ''),
        now: new Date('2026-10-20T00:02:00.000Z'),
      }),
      acceptExecutionCallback(prisma, {
        attemptId: attempt?.id ?? '',
        callbackClaimId: execution.callbackClaim?.id ?? '',
        status: 'FAILED',
        reason: 'Runner failed after cancellation was requested',
        events: [{ type: 'started', attemptId: attempt?.id ?? '' }],
        now: new Date('2026-10-20T00:02:00.000Z'),
      }),
      acceptExecutionCallback(prisma, {
        attemptId: attempt?.id ?? '',
        callbackClaimId: execution.callbackClaim?.id ?? '',
        status: 'CANCELLED',
        events: [{ type: 'started', attemptId: attempt?.id ?? '' }],
        now: new Date('2026-10-20T00:02:00.000Z'),
      }),
    ]);

    expect(callbacks.filter((callback) => callback.accepted)).toHaveLength(1);
    expect(
      await prisma.execution.findUniqueOrThrow({
        where: { id: execution.id },
        select: {
          status: true,
          cancellationRequest: { select: { status: true } },
        },
      }),
    ).toSatisfy((storedExecution) => {
      if (storedExecution.status === 'CANCELLED') {
        return storedExecution.cancellationRequest?.status === 'COMPLETED';
      }
      return (
        ['COMPLETED', 'FAILED'].includes(storedExecution.status) &&
        storedExecution.cancellationRequest?.status === 'SUPERSEDED'
      );
    });
  });

  test('allows one owner per conversation while independent conversations proceed', async () => {
    const sameConversation = await Promise.all([
      tryClaimConversation(redis, `${testPrefix}-conversation`, 'worker-a'),
      tryClaimConversation(redis, `${testPrefix}-conversation`, 'worker-b'),
    ]);

    expect(sameConversation.filter(Boolean)).toHaveLength(1);
    expect(
      await tryClaimConversation(
        redis,
        `${testPrefix}-other-conversation`,
        'worker-c',
      ),
    ).toBe(true);
    expect(
      await releaseConversationClaim(
        redis,
        `${testPrefix}-conversation`,
        'worker-a',
      ),
    ).toBe(sameConversation[0]);
  });
});
