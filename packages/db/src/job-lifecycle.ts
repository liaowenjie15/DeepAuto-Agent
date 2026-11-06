import {
  AttemptStatus,
  ExecutionStatus,
  type JobAttempt,
  JobStatus,
  OutboxEventKind,
  type PrismaClient,
} from './generated/prisma/client';

export type TerminalAttemptStatus =
  | typeof AttemptStatus.COMPLETED
  | typeof AttemptStatus.FAILED
  | typeof AttemptStatus.CANCELLED;

export type AttemptCompletion = {
  accepted: boolean;
  shouldNotify: boolean;
};

export type RequestJobCancellationInput = {
  jobId: string;
  requestedByActorId: string;
  now?: Date;
};

export type JobCancellationRequestResult = {
  accepted: boolean;
  state: 'cancelled' | 'requested' | 'already_requested' | 'not_cancellable';
  executionId?: string;
};

export type RejectQueuedJobForPolicyInput = {
  jobId: string;
  reason: string;
  now?: Date;
};

const jobStatusForAttemptStatus = {
  [AttemptStatus.COMPLETED]: JobStatus.COMPLETED,
  [AttemptStatus.FAILED]: JobStatus.FAILED,
  [AttemptStatus.CANCELLED]: JobStatus.CANCELLED,
} as const;

export async function isJobAtConversationHead(
  prisma: PrismaClient,
  jobId: string,
  conversationKey: string,
): Promise<boolean> {
  const head = await prisma.job.findFirst({
    where: {
      conversationKey,
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return head?.id === jobId;
}

export async function beginJobAttempt(
  prisma: PrismaClient,
  jobId: string,
): Promise<JobAttempt | null> {
  return prisma.$transaction(async (transaction) => {
    const claimed = await transaction.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.QUEUED,
        cancelledAt: null,
      },
      data: {
        status: JobStatus.RUNNING,
        currentAttemptNumber: { increment: 1 },
      },
    });

    if (claimed.count === 0) return null;

    const job = await transaction.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { currentAttemptNumber: true },
    });

    return transaction.jobAttempt.create({
      data: {
        jobId,
        number: job.currentAttemptNumber,
      },
    });
  });
}

export async function rejectQueuedJobForPolicy(
  prisma: PrismaClient,
  input: RejectQueuedJobForPolicyInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    const job = await transaction.job.findFirst({
      where: {
        id: input.jobId,
        status: JobStatus.QUEUED,
        cancelledAt: null,
      },
      select: {
        id: true,
        invocation: { select: { workspaceId: true, actorId: true } },
      },
    });
    if (!job) return false;

    const rejected = await transaction.job.updateMany({
      where: {
        id: job.id,
        status: JobStatus.QUEUED,
        cancelledAt: null,
      },
      data: { status: JobStatus.FAILED, updatedAt: now },
    });
    if (rejected.count !== 1) return false;

    await transaction.auditEvent.create({
      data: {
        workspaceId: job.invocation.workspaceId,
        actorId: job.invocation.actorId,
        jobId: job.id,
        action: 'job_rejected_by_execution_policy',
        metadata: { reason: input.reason },
      },
    });
    return true;
  });
}

export async function finishJobAttempt(
  prisma: PrismaClient,
  attemptId: string,
  status: TerminalAttemptStatus,
): Promise<AttemptCompletion> {
  return prisma.$transaction(async (transaction) => {
    const attempt = await transaction.jobAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { jobId: true, number: true },
    });
    const finishedAt = new Date();
    const updatedJob = await transaction.job.updateMany({
      where: {
        id: attempt.jobId,
        status: JobStatus.RUNNING,
        currentAttemptNumber: attempt.number,
      },
      data: {
        status: jobStatusForAttemptStatus[status],
        cancelledAt:
          status === AttemptStatus.CANCELLED ? finishedAt : undefined,
      },
    });

    if (updatedJob.count === 0) {
      return { accepted: false, shouldNotify: false };
    }

    const completed = await transaction.jobAttempt.updateMany({
      where: { id: attemptId, status: AttemptStatus.RUNNING },
      data: { status, finishedAt },
    });

    if (completed.count !== 1) {
      throw new Error('A claimed Job attempt is no longer running');
    }

    return { accepted: true, shouldNotify: true };
  });
}

export async function requeueFailedJob(
  prisma: PrismaClient,
  jobId: string,
): Promise<boolean> {
  const requeued = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: JobStatus.FAILED,
      cancelledAt: null,
    },
    data: { status: JobStatus.QUEUED },
  });
  return requeued.count === 1;
}

export async function requestJobCancellation(
  prisma: PrismaClient,
  input: RequestJobCancellationInput,
): Promise<JobCancellationRequestResult> {
  return prisma.$transaction(async (transaction) => {
    const now = input.now ?? new Date();
    const job = await transaction.job.findUnique({
      where: { id: input.jobId },
      select: { currentAttemptNumber: true, status: true },
    });

    if (!job) return { accepted: false, state: 'not_cancellable' };

    if (job.status === JobStatus.QUEUED) {
      const cancelled = await transaction.job.updateMany({
        where: { id: input.jobId, status: JobStatus.QUEUED },
        data: { status: JobStatus.CANCELLED, cancelledAt: now },
      });
      return cancelled.count === 1
        ? { accepted: true, state: 'cancelled' }
        : { accepted: false, state: 'not_cancellable' };
    }

    if (job.status !== JobStatus.RUNNING) {
      return { accepted: false, state: 'not_cancellable' };
    }

    const claimedRunningJob = await transaction.job.updateMany({
      where: {
        id: input.jobId,
        status: JobStatus.RUNNING,
        currentAttemptNumber: job.currentAttemptNumber,
      },
      data: { updatedAt: now },
    });
    if (claimedRunningJob.count !== 1) {
      return { accepted: false, state: 'not_cancellable' };
    }

    const execution = await transaction.execution.findFirst({
      where: {
        status: ExecutionStatus.RUNNING,
        attempt: {
          jobId: input.jobId,
          number: job.currentAttemptNumber,
          status: AttemptStatus.RUNNING,
        },
      },
      select: { id: true },
    });

    if (!execution) {
      const cancelled = await transaction.job.updateMany({
        where: {
          id: input.jobId,
          status: JobStatus.RUNNING,
          currentAttemptNumber: job.currentAttemptNumber,
        },
        data: { status: JobStatus.CANCELLED, cancelledAt: now },
      });
      if (cancelled.count !== 1) {
        return { accepted: false, state: 'not_cancellable' };
      }

      await transaction.jobAttempt.updateMany({
        where: {
          jobId: input.jobId,
          number: job.currentAttemptNumber,
          status: AttemptStatus.RUNNING,
        },
        data: { status: AttemptStatus.CANCELLED, finishedAt: now },
      });
      return { accepted: true, state: 'cancelled' };
    }

    const existingRequest =
      await transaction.executionCancellationRequest.findUnique({
        where: { executionId: execution.id },
        select: { id: true },
      });
    if (existingRequest) {
      return {
        accepted: true,
        state: 'already_requested',
        executionId: execution.id,
      };
    }

    await transaction.executionCancellationRequest.create({
      data: {
        executionId: execution.id,
        requestedAt: now,
        requestedByActorId: input.requestedByActorId,
      },
    });
    await transaction.outboxEvent.create({
      data: {
        jobId: input.jobId,
        kind: OutboxEventKind.EXECUTION_CANCEL,
        queueSequence: job.currentAttemptNumber,
        dedupeKey: `execution:${execution.id}:cancel`,
      },
    });

    return { accepted: true, state: 'requested', executionId: execution.id };
  });
}

export async function recoverExpiredJobAttempts(
  prisma: PrismaClient,
  expiredBefore: Date,
): Promise<string[]> {
  const candidates = await prisma.jobAttempt.findMany({
    where: {
      status: AttemptStatus.RUNNING,
      startedAt: { lt: expiredBefore },
      job: { status: JobStatus.RUNNING, cancelledAt: null },
      OR: [
        { execution: { is: null } },
        { execution: { is: { cancellationRequest: { is: null } } } },
      ],
    },
    select: { id: true, jobId: true, number: true },
  });
  const recoveredJobIds: string[] = [];

  for (const attempt of candidates) {
    const recovered = await prisma.$transaction(async (transaction) => {
      const failedAttempt = await transaction.jobAttempt.updateMany({
        where: { id: attempt.id, status: AttemptStatus.RUNNING },
        data: { status: AttemptStatus.FAILED, finishedAt: new Date() },
      });

      if (failedAttempt.count === 0) return false;

      const requeuedJob = await transaction.job.updateMany({
        where: {
          id: attempt.jobId,
          status: JobStatus.RUNNING,
          currentAttemptNumber: attempt.number,
          cancelledAt: null,
        },
        data: { status: JobStatus.QUEUED },
      });

      if (requeuedJob.count === 0) return false;

      await transaction.execution.updateMany({
        where: { attemptId: attempt.id, status: 'RUNNING' },
        data: {
          status: 'TIMED_OUT',
          reason: 'Job attempt lease expired',
          finishedAt: new Date(),
        },
      });

      await transaction.outboxEvent.create({
        data: {
          jobId: attempt.jobId,
          kind: 'JOB_ENQUEUE',
          queueSequence: attempt.number + 1,
          dedupeKey: `job:${attempt.jobId}:enqueue:${attempt.number + 1}`,
        },
      });
      return true;
    });

    if (recovered) recoveredJobIds.push(attempt.jobId);
  }

  return recoveredJobIds;
}
