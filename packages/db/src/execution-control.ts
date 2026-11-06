import {
  AttemptStatus,
  ExecutionCancellationRequestStatus,
  ExecutionStatus,
  JobStatus,
  OutboxEventKind,
  type PrismaClient,
} from './generated/prisma/client';

export type ExternalExecutionTerminalStatus =
  | typeof ExecutionStatus.COMPLETED
  | typeof ExecutionStatus.FAILED
  | typeof ExecutionStatus.CANCELLED
  | typeof ExecutionStatus.TIMED_OUT;

export type ExecutionCancellationControl = {
  cancellationRequestId: string;
  executionId: string;
  attemptCount: number;
  externalRunId: bigint | null;
  externalUrl: string | null;
  status:
    | typeof ExecutionCancellationRequestStatus.REQUESTED
    | typeof ExecutionCancellationRequestStatus.DISPATCHED;
};

export type ExecutionConversationReleaseControl = {
  executionId: string;
  conversationKey: string;
};

export type RecordExecutionCancellationAttemptInput = {
  cancellationRequestId: string;
  executionId: string;
  status?:
    | typeof ExecutionCancellationRequestStatus.REQUESTED
    | typeof ExecutionCancellationRequestStatus.DISPATCHED;
  externalRunId?: bigint;
  externalUrl?: string;
  lastError?: string | null;
  now?: Date;
};

function jobStatusForExecutionStatus(
  status: ExternalExecutionTerminalStatus,
):
  | typeof JobStatus.COMPLETED
  | typeof JobStatus.FAILED
  | typeof JobStatus.CANCELLED {
  if (status === ExecutionStatus.COMPLETED) return JobStatus.COMPLETED;
  if (status === ExecutionStatus.CANCELLED) return JobStatus.CANCELLED;
  return JobStatus.FAILED;
}

function attemptStatusForExecutionStatus(
  status: ExternalExecutionTerminalStatus,
):
  | typeof AttemptStatus.COMPLETED
  | typeof AttemptStatus.FAILED
  | typeof AttemptStatus.CANCELLED {
  if (status === ExecutionStatus.COMPLETED) return AttemptStatus.COMPLETED;
  if (status === ExecutionStatus.CANCELLED) return AttemptStatus.CANCELLED;
  return AttemptStatus.FAILED;
}

export async function getExecutionCancellationControl(
  prisma: PrismaClient,
  outboxEventId: string,
): Promise<ExecutionCancellationControl | null> {
  const outboxEvent = await prisma.outboxEvent.findFirst({
    where: { id: outboxEventId, kind: OutboxEventKind.EXECUTION_CANCEL },
    select: { jobId: true, queueSequence: true },
  });
  if (!outboxEvent) return null;

  const cancellationRequest =
    await prisma.executionCancellationRequest.findFirst({
      where: {
        status: {
          in: [
            ExecutionCancellationRequestStatus.REQUESTED,
            ExecutionCancellationRequestStatus.DISPATCHED,
          ],
        },
        execution: {
          status: ExecutionStatus.RUNNING,
          attempt: {
            jobId: outboxEvent.jobId,
            number: outboxEvent.queueSequence,
            status: AttemptStatus.RUNNING,
            job: { status: JobStatus.RUNNING, cancelledAt: null },
          },
        },
      },
      select: {
        id: true,
        executionId: true,
        attemptCount: true,
        status: true,
        execution: { select: { externalRunId: true, externalUrl: true } },
      },
    });
  if (!cancellationRequest) return null;
  if (
    cancellationRequest.status !==
      ExecutionCancellationRequestStatus.REQUESTED &&
    cancellationRequest.status !== ExecutionCancellationRequestStatus.DISPATCHED
  ) {
    return null;
  }

  return {
    cancellationRequestId: cancellationRequest.id,
    executionId: cancellationRequest.executionId,
    attemptCount: cancellationRequest.attemptCount,
    externalRunId: cancellationRequest.execution.externalRunId,
    externalUrl: cancellationRequest.execution.externalUrl,
    status: cancellationRequest.status,
  };
}

export async function getExecutionConversationReleaseControl(
  prisma: PrismaClient,
  outboxEventId: string,
): Promise<ExecutionConversationReleaseControl | null> {
  const outboxEvent = await prisma.outboxEvent.findFirst({
    where: {
      id: outboxEventId,
      kind: OutboxEventKind.EXECUTION_CONVERSATION_RELEASE,
    },
    select: { jobId: true, queueSequence: true },
  });
  if (!outboxEvent) return null;

  const attempt = await prisma.jobAttempt.findFirst({
    where: {
      jobId: outboxEvent.jobId,
      number: outboxEvent.queueSequence,
      execution: {
        status: {
          in: [
            ExecutionStatus.COMPLETED,
            ExecutionStatus.FAILED,
            ExecutionStatus.CANCELLED,
            ExecutionStatus.TIMED_OUT,
          ],
        },
      },
    },
    select: {
      execution: { select: { id: true } },
      job: { select: { conversationKey: true } },
    },
  });
  if (!attempt?.execution) return null;

  return {
    executionId: attempt.execution.id,
    conversationKey: attempt.job.conversationKey,
  };
}

export async function recordExecutionCancellationAttempt(
  prisma: PrismaClient,
  input: RecordExecutionCancellationAttemptInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    if (input.externalRunId !== undefined) {
      const execution = await transaction.execution.updateMany({
        where: {
          id: input.executionId,
          status: ExecutionStatus.RUNNING,
          OR: [{ externalRunId: null }, { externalRunId: input.externalRunId }],
        },
        data: {
          externalRunId: input.externalRunId,
          externalUrl: input.externalUrl,
        },
      });
      if (execution.count !== 1) return false;
    }

    const cancellationRequest =
      await transaction.executionCancellationRequest.updateMany({
        where: {
          id: input.cancellationRequestId,
          executionId: input.executionId,
          status: {
            in: [
              ExecutionCancellationRequestStatus.REQUESTED,
              ExecutionCancellationRequestStatus.DISPATCHED,
            ],
          },
        },
        data: {
          status: input.status,
          attemptCount: { increment: 1 },
          lastAttemptAt: now,
          lastError: input.lastError,
        },
      });
    return cancellationRequest.count === 1;
  });
}

export async function failExecutionCancellation(
  prisma: PrismaClient,
  input: {
    cancellationRequestId: string;
    executionId: string;
    reason: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const failed = await prisma.executionCancellationRequest.updateMany({
    where: {
      id: input.cancellationRequestId,
      executionId: input.executionId,
      status: {
        in: [
          ExecutionCancellationRequestStatus.REQUESTED,
          ExecutionCancellationRequestStatus.DISPATCHED,
        ],
      },
    },
    data: {
      status: ExecutionCancellationRequestStatus.FAILED,
      lastError: input.reason,
      lastAttemptAt: now,
    },
  });
  return failed.count === 1;
}

export async function recordExecutionCancellationReconciliationFailure(
  prisma: PrismaClient,
  input: {
    cancellationRequestId: string;
    executionId: string;
    reason: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    const cancellationRequest =
      await transaction.executionCancellationRequest.findFirst({
        where: {
          id: input.cancellationRequestId,
          executionId: input.executionId,
          status: {
            in: [
              ExecutionCancellationRequestStatus.REQUESTED,
              ExecutionCancellationRequestStatus.DISPATCHED,
            ],
          },
        },
        select: {
          requestedByActorId: true,
          attemptCount: true,
          execution: {
            select: {
              attemptId: true,
              attempt: {
                select: {
                  jobId: true,
                  job: {
                    select: { invocation: { select: { workspaceId: true } } },
                  },
                },
              },
            },
          },
        },
      });
    if (!cancellationRequest) return false;

    const failed = await transaction.executionCancellationRequest.updateMany({
      where: {
        id: input.cancellationRequestId,
        executionId: input.executionId,
        status: {
          in: [
            ExecutionCancellationRequestStatus.REQUESTED,
            ExecutionCancellationRequestStatus.DISPATCHED,
          ],
        },
      },
      data: {
        status: ExecutionCancellationRequestStatus.FAILED,
        lastError: input.reason,
        lastAttemptAt: now,
      },
    });
    if (failed.count !== 1) return false;

    await transaction.auditEvent.create({
      data: {
        workspaceId:
          cancellationRequest.execution.attempt.job.invocation.workspaceId,
        actorId: cancellationRequest.requestedByActorId,
        jobId: cancellationRequest.execution.attempt.jobId,
        attemptId: cancellationRequest.execution.attemptId,
        action: 'execution_cancellation_reconciliation_exhausted',
        metadata: {
          executionId: input.executionId,
          attemptCount: cancellationRequest.attemptCount,
          reason: input.reason,
        },
      },
    });
    return true;
  });
}

export async function recordExternalExecutionTerminalStatus(
  prisma: PrismaClient,
  input: {
    executionId: string;
    status: ExternalExecutionTerminalStatus;
    reason: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (transaction) => {
    const execution = await transaction.execution.findFirst({
      where: { id: input.executionId, status: ExecutionStatus.RUNNING },
      select: { id: true, attemptId: true },
    });
    if (!execution) return false;

    const attempt = await transaction.jobAttempt.findUniqueOrThrow({
      where: { id: execution.attemptId },
      select: { jobId: true, number: true },
    });
    const job = await transaction.job.updateMany({
      where: {
        id: attempt.jobId,
        status: JobStatus.RUNNING,
        currentAttemptNumber: attempt.number,
      },
      data: {
        status: jobStatusForExecutionStatus(input.status),
        cancelledAt:
          input.status === ExecutionStatus.CANCELLED ? now : undefined,
      },
    });
    if (job.count !== 1) return false;

    const updatedAttempt = await transaction.jobAttempt.updateMany({
      where: { id: execution.attemptId, status: AttemptStatus.RUNNING },
      data: {
        status: attemptStatusForExecutionStatus(input.status),
        finishedAt: now,
      },
    });
    if (updatedAttempt.count !== 1) {
      throw new Error('A claimed Job attempt is no longer running');
    }

    await transaction.execution.update({
      where: { id: execution.id },
      data: { status: input.status, reason: input.reason, finishedAt: now },
    });
    await transaction.executionCallbackClaim.updateMany({
      where: { executionId: execution.id, usedAt: null },
      data: { usedAt: now },
    });
    await transaction.executionCancellationRequest.updateMany({
      where: { executionId: execution.id },
      data: {
        status:
          input.status === ExecutionStatus.CANCELLED
            ? ExecutionCancellationRequestStatus.COMPLETED
            : ExecutionCancellationRequestStatus.SUPERSEDED,
      },
    });
    await transaction.outboxEvent.create({
      data: {
        jobId: attempt.jobId,
        kind: OutboxEventKind.EXECUTION_CONVERSATION_RELEASE,
        queueSequence: attempt.number,
        dedupeKey: `execution:${execution.id}:conversation-release`,
      },
    });
    return true;
  });
}
