import type { ExecutionEvent } from '@deepauto/contracts';
import {
  AttemptStatus,
  ExecutionArtifactName,
  ExecutionEventType,
  type ExecutionStatus,
  JobStatus,
  type Prisma,
  type PrismaClient,
} from './generated/prisma/client';

export type StartExecutionInput = {
  attemptId: string;
  callbackExpiresAt: Date;
};

export type ExecutionCallbackInput = {
  attemptId: string;
  callbackClaimId: string;
  status: ExecutionStatus;
  reason?: string;
  events: ExecutionEvent[];
  now?: Date;
};

export type ExecutionCallbackResult = {
  accepted: boolean;
};

const terminalEventTypes = new Set(['completed', 'failed']);

const artifactNames = {
  diff: ExecutionArtifactName.DIFF,
  test_result: ExecutionArtifactName.TEST_RESULT,
  commit_sha: ExecutionArtifactName.COMMIT_SHA,
  pull_request: ExecutionArtifactName.PULL_REQUEST,
  workspace: ExecutionArtifactName.WORKSPACE,
} as const;

const eventTypes = {
  started: ExecutionEventType.STARTED,
  progress: ExecutionEventType.PROGRESS,
  artifact: ExecutionEventType.ARTIFACT,
  completed: ExecutionEventType.COMPLETED,
  failed: ExecutionEventType.FAILED,
} as const;

function assertCallbackEvents(
  attemptId: string,
  status: ExecutionStatus,
  reason: string | undefined,
  events: ExecutionEvent[],
): void {
  if (events.length === 0) {
    if (status === 'FAILED' && reason?.trim()) return;
    throw new Error('Execution callback must begin with a started event');
  }
  if (events[0]?.type !== 'started') {
    throw new Error('Execution callback must begin with a started event');
  }

  const artifactNamesSeen = new Set<string>();
  let terminalSeen = false;
  let terminalType: ExecutionEvent['type'] | undefined;

  for (const event of events) {
    if (event.attemptId !== attemptId) {
      throw new Error('Execution callback event does not match the attempt');
    }
    if (terminalSeen) {
      throw new Error(
        'Execution callback cannot contain events after terminal',
      );
    }
    if (event.type === 'artifact') {
      if (artifactNamesSeen.has(event.name)) {
        throw new Error('Execution callback cannot repeat an artifact name');
      }
      artifactNamesSeen.add(event.name);
    }
    if (terminalEventTypes.has(event.type)) {
      terminalSeen = true;
      terminalType = event.type;
    }
  }

  if (status === 'COMPLETED' && terminalType !== 'completed') {
    throw new Error('A completed execution requires a completed event');
  }
  if ((status === 'CANCELLED' || status === 'TIMED_OUT') && terminalSeen) {
    throw new Error(
      'Cancelled or timed out executions cannot report a terminal CLI event',
    );
  }
}

function attemptStatusForExecution(
  status: ExecutionStatus,
):
  | typeof AttemptStatus.COMPLETED
  | typeof AttemptStatus.FAILED
  | typeof AttemptStatus.CANCELLED {
  if (status === 'COMPLETED') return AttemptStatus.COMPLETED;
  if (status === 'CANCELLED') return AttemptStatus.CANCELLED;
  return AttemptStatus.FAILED;
}

function jobStatusForExecution(
  status: ExecutionStatus,
):
  | typeof JobStatus.COMPLETED
  | typeof JobStatus.FAILED
  | typeof JobStatus.CANCELLED {
  if (status === 'COMPLETED') return JobStatus.COMPLETED;
  if (status === 'CANCELLED') return JobStatus.CANCELLED;
  return JobStatus.FAILED;
}

export async function startExecution(
  prisma: PrismaClient,
  input: StartExecutionInput,
  now = new Date(),
) {
  if (input.callbackExpiresAt <= now) {
    throw new Error('Execution callback claim expiry must be in the future');
  }

  return prisma.$transaction(async (transaction) => {
    const attempt = await transaction.jobAttempt.findFirst({
      where: {
        id: input.attemptId,
        status: AttemptStatus.RUNNING,
        job: { status: JobStatus.RUNNING, cancelledAt: null },
      },
      select: { id: true },
    });

    if (!attempt) {
      throw new Error('Execution must belong to an active Job attempt');
    }

    return transaction.execution.create({
      data: {
        attemptId: attempt.id,
        callbackClaim: { create: { expiresAt: input.callbackExpiresAt } },
      },
      include: { callbackClaim: true },
    });
  });
}

export async function acceptExecutionCallback(
  prisma: PrismaClient,
  input: ExecutionCallbackInput,
): Promise<ExecutionCallbackResult> {
  const now = input.now ?? new Date();
  assertCallbackEvents(
    input.attemptId,
    input.status,
    input.reason,
    input.events,
  );

  return prisma.$transaction(async (transaction) => {
    const execution = await transaction.execution.findFirst({
      where: {
        attemptId: input.attemptId,
        status: 'RUNNING',
        callbackClaim: {
          id: input.callbackClaimId,
          usedAt: null,
          expiresAt: { gt: now },
        },
      },
      select: { id: true, attemptId: true },
    });

    if (!execution) return { accepted: false };

    const attempt = await transaction.jobAttempt.findUniqueOrThrow({
      where: { id: execution.attemptId },
      select: { jobId: true, number: true },
    });
    const jobStatus = jobStatusForExecution(input.status);
    const attemptStatus = attemptStatusForExecution(input.status);
    const updatedJob = await transaction.job.updateMany({
      where: {
        id: attempt.jobId,
        status: JobStatus.RUNNING,
        currentAttemptNumber: attempt.number,
      },
      data: {
        status: jobStatus,
        cancelledAt: input.status === 'CANCELLED' ? now : undefined,
      },
    });
    if (updatedJob.count !== 1) return { accepted: false };

    const consumedClaim = await transaction.executionCallbackClaim.updateMany({
      where: {
        id: input.callbackClaimId,
        executionId: execution.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (consumedClaim.count !== 1) {
      throw new Error('A claimed execution callback is no longer available');
    }

    const updatedAttempt = await transaction.jobAttempt.updateMany({
      where: { id: execution.attemptId, status: AttemptStatus.RUNNING },
      data: { status: attemptStatus, finishedAt: now },
    });
    if (updatedAttempt.count !== 1) {
      throw new Error('A claimed Job attempt is no longer running');
    }

    await transaction.execution.update({
      where: { id: execution.id },
      data: { status: input.status, reason: input.reason, finishedAt: now },
    });
    await transaction.executionEvent.createMany({
      data: input.events.map((event, index) => ({
        executionId: execution.id,
        sequence: index + 1,
        type: eventTypes[event.type],
        payload: event as Prisma.InputJsonValue,
      })),
    });
    const artifacts = input.events.filter(
      (event): event is Extract<ExecutionEvent, { type: 'artifact' }> =>
        event.type === 'artifact',
    );
    if (artifacts.length > 0) {
      await transaction.executionArtifact.createMany({
        data: artifacts.map((artifact) => ({
          executionId: execution.id,
          name: artifactNames[artifact.name],
          value: artifact.value,
        })),
      });
    }

    return { accepted: true };
  });
}
