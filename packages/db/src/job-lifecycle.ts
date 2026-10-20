import {
  AttemptStatus,
  type JobAttempt,
  JobStatus,
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

const jobStatusForAttemptStatus = {
  [AttemptStatus.COMPLETED]: JobStatus.COMPLETED,
  [AttemptStatus.FAILED]: JobStatus.FAILED,
  [AttemptStatus.CANCELLED]: JobStatus.CANCELLED,
} as const;

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
  jobId: string,
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const cancelledAt = new Date();
    const job = await transaction.job.findUnique({
      where: { id: jobId },
      select: { currentAttemptNumber: true },
    });

    if (!job) return false;

    const cancelled = await transaction.job.updateMany({
      where: {
        id: jobId,
        status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
      },
      data: {
        status: JobStatus.CANCELLED,
        cancelledAt,
      },
    });

    if (cancelled.count === 0) return false;

    await transaction.jobAttempt.updateMany({
      where: {
        jobId,
        number: job.currentAttemptNumber,
        status: AttemptStatus.RUNNING,
      },
      data: { status: AttemptStatus.CANCELLED, finishedAt: cancelledAt },
    });
    await transaction.execution.updateMany({
      where: {
        attempt: { jobId, number: job.currentAttemptNumber },
        status: 'RUNNING',
      },
      data: {
        status: 'CANCELLED',
        reason: 'Job cancellation requested',
        finishedAt: cancelledAt,
      },
    });

    return true;
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
