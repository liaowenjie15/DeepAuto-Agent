import { createHash, randomBytes } from 'node:crypto';
import {
  type ExecutionEvent,
  type ExecutionResult,
  executionResultSchema,
} from '@deepauto/contracts';
import {
  AttemptStatus,
  ExecutionArtifactName,
  ExecutionCancellationRequestStatus,
  ExecutionEventType,
  ExecutionFailureCategory,
  ExecutionLogProvider,
  type ExecutionStatus,
  JobStatus,
  type Prisma,
  type PrismaClient,
} from './generated/prisma/client';

export type StartExecutionInput = {
  attemptId: string;
  callbackExpiresAt: Date;
  bootstrapCapabilityHash?: string;
  bootstrapExpiresAt?: Date;
};

type TerminalExecutionStatus = Exclude<ExecutionStatus, 'RUNNING'>;

export type ExecutionCallbackInput = {
  attemptId: string;
  callbackClaimId: string;
  events: ExecutionEvent[];
  now?: Date;
} & (
  | { result: ExecutionResult; status?: never; reason?: never }
  | { result?: never; status: TerminalExecutionStatus; reason?: string }
);

export type ExecutionCallbackResult = {
  accepted: boolean;
  retryScheduled?: true;
};

type CallbackAcceptanceOptions = {
  executionId?: string;
  externalRunId?: bigint;
  acceptExpiredClaim?: boolean;
};

export type ExpiredExecutionCallback = {
  executionId: string;
  attemptId: string;
  externalRunId: bigint;
};

export type ExecutionBootstrap = {
  executionId: string;
  attemptId: string;
  instruction: string;
};

export type ExecutionBootstrapCapability = {
  value: string;
  hash: string;
};

export function createExecutionBootstrapCapability(): ExecutionBootstrapCapability {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: hashExecutionBootstrapCapability(value) };
}

export function hashExecutionBootstrapCapability(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function recordExecutionExternalRun(
  prisma: PrismaClient,
  executionId: string,
  externalRunId: bigint,
): Promise<boolean> {
  const bound = await prisma.execution.updateMany({
    where: {
      id: executionId,
      status: 'RUNNING',
      OR: [{ externalRunId: null }, { externalRunId }],
    },
    data: { externalRunId },
  });
  return bound.count === 1;
}

export async function bindExecutionToExternalRun(
  prisma: PrismaClient,
  executionId: string,
  externalRunId: bigint,
  externalRunAttempt: number,
): Promise<boolean> {
  const execution = await prisma.execution.findFirst({
    where: {
      id: executionId,
      status: 'RUNNING',
      externalRunId,
      externalRunAttempt,
    },
    select: { id: true },
  });
  return execution !== null;
}

export async function consumeExecutionBootstrapCapability(
  prisma: PrismaClient,
  executionId: string,
  capability: string,
  externalRunId: bigint,
  externalRunAttempt: number,
  now = new Date(),
): Promise<boolean> {
  const capabilityHash = hashExecutionBootstrapCapability(capability);
  return prisma.$transaction(async (transaction) => {
    const consumed = await transaction.execution.updateMany({
      where: {
        id: executionId,
        status: 'RUNNING',
        externalRunId: null,
        bootstrapCapabilityHash: capabilityHash,
        bootstrapUsedAt: null,
        bootstrapExpiresAt: { gt: now },
      },
      data: {
        externalRunId,
        externalRunAttempt,
        bootstrapCapabilityHash: null,
        bootstrapUsedAt: now,
      },
    });
    if (consumed.count === 1) return true;

    const execution = await transaction.execution.findFirst({
      where: {
        id: executionId,
        status: 'RUNNING',
        externalRunId,
        externalRunAttempt,
      },
      select: { id: true },
    });
    return execution !== null;
  });
}

export type ExecutionCallbackByExecutionIdInput =
  | (Omit<
      Extract<ExecutionCallbackInput, { result: ExecutionResult }>,
      'callbackClaimId'
    > & {
      executionId: string;
    })
  | (Omit<
      Extract<ExecutionCallbackInput, { status: TerminalExecutionStatus }>,
      'attemptId' | 'callbackClaimId'
    > & {
      executionId: string;
    });

const terminalEventTypes = new Set(['completed', 'failed']);

const artifactNames = {
  diff: ExecutionArtifactName.DIFF,
  test_result: ExecutionArtifactName.TEST_RESULT,
  commit_sha: ExecutionArtifactName.COMMIT_SHA,
  pull_request: ExecutionArtifactName.PULL_REQUEST,
  prompt_layers: ExecutionArtifactName.PROMPT_LAYERS,
  workspace: ExecutionArtifactName.WORKSPACE,
} as const;

const eventTypes = {
  started: ExecutionEventType.STARTED,
  progress: ExecutionEventType.PROGRESS,
  artifact: ExecutionEventType.ARTIFACT,
  completed: ExecutionEventType.COMPLETED,
  failed: ExecutionEventType.FAILED,
} as const;

const failureCategories = {
  VALIDATION_FAILED: ExecutionFailureCategory.VALIDATION_FAILED,
  POLICY_REJECTED: ExecutionFailureCategory.POLICY_REJECTED,
  CANCELLED: ExecutionFailureCategory.CANCELLED,
  TIMEOUT: ExecutionFailureCategory.TIMEOUT,
  INFRASTRUCTURE_FAILED: ExecutionFailureCategory.INFRASTRUCTURE_FAILED,
  CALLBACK_REJECTED: ExecutionFailureCategory.CALLBACK_REJECTED,
} as const;

const logProviders = {
  github_actions: ExecutionLogProvider.GITHUB_ACTIONS,
  local_sandbox: ExecutionLogProvider.LOCAL_SANDBOX,
} as const;

const maximumAutomaticRetries = 2;
const initialRetryBackoffMilliseconds = 5_000;

function assertCallbackEvents(
  attemptId: string,
  result: ExecutionResult,
  events: ExecutionEvent[],
): void {
  if (events.length === 0) {
    if (result.status !== 'COMPLETED') return;
    throw new Error('A completed callback must begin with a started event');
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

  if (result.status === 'COMPLETED' && terminalType !== 'completed') {
    throw new Error('A completed execution requires a completed event');
  }
  if (
    (result.status === 'CANCELLED' || result.status === 'TIMED_OUT') &&
    terminalSeen
  ) {
    throw new Error(
      'Cancelled or timed out executions cannot report a terminal CLI event',
    );
  }
}

function shouldScheduleRetry(result: ExecutionResult, attemptNumber: number) {
  return result.retryable && attemptNumber <= maximumAutomaticRetries;
}

function retryAvailableAt(attemptNumber: number, now: Date): Date {
  return new Date(
    now.getTime() + initialRetryBackoffMilliseconds * 2 ** (attemptNumber - 1),
  );
}

function resultFromLegacyCallback(
  input: ExecutionCallbackInput,
): ExecutionResult {
  if (input.result) return input.result;

  const artifacts = input.events.flatMap((event) =>
    event.type === 'artifact'
      ? [{ name: event.name, reference: event.value }]
      : [],
  );
  const status = input.status;
  const failureCategory =
    status === 'CANCELLED'
      ? 'CANCELLED'
      : status === 'TIMED_OUT'
        ? 'TIMEOUT'
        : status === 'FAILED'
          ? 'VALIDATION_FAILED'
          : undefined;
  return {
    status,
    failureCategory,
    safeSummary:
      status === 'COMPLETED'
        ? 'Execution completed successfully.'
        : status === 'CANCELLED'
          ? 'Execution was cancelled.'
          : status === 'TIMED_OUT'
            ? 'Execution exceeded its deadline and will retry.'
            : 'Execution validation failed.',
    retryable: status === 'TIMED_OUT',
    artifacts,
    finishedAt: (input.now ?? new Date()).toISOString(),
  };
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
  if (
    (input.bootstrapCapabilityHash === undefined) !==
    (input.bootstrapExpiresAt === undefined)
  ) {
    throw new Error(
      'Execution bootstrap capability hash and expiry must be provided together',
    );
  }
  if (input.bootstrapExpiresAt && input.bootstrapExpiresAt <= now) {
    throw new Error(
      'Execution bootstrap capability expiry must be in the future',
    );
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
        bootstrapCapabilityHash: input.bootstrapCapabilityHash,
        bootstrapExpiresAt: input.bootstrapExpiresAt,
        callbackClaim: { create: { expiresAt: input.callbackExpiresAt } },
      },
      include: { callbackClaim: true },
    });
  });
}

export async function getActiveExecutionBootstrap(
  prisma: PrismaClient,
  executionId: string,
  now = new Date(),
): Promise<ExecutionBootstrap | null> {
  const execution = await prisma.execution.findFirst({
    where: {
      id: executionId,
      status: 'RUNNING',
      callbackClaim: { usedAt: null, expiresAt: { gt: now } },
      cancellationRequest: { is: null },
      attempt: {
        status: AttemptStatus.RUNNING,
        job: { status: JobStatus.RUNNING, cancelledAt: null },
      },
    },
    select: {
      id: true,
      attemptId: true,
      attempt: {
        select: {
          job: { select: { invocation: { select: { instruction: true } } } },
        },
      },
    },
  });

  if (!execution) return null;

  return {
    executionId: execution.id,
    attemptId: execution.attemptId,
    instruction: execution.attempt.job.invocation.instruction,
  };
}

export async function reconcileExpiredExecutionBootstraps(
  prisma: PrismaClient,
  now = new Date(),
): Promise<string[]> {
  const expired = await prisma.execution.findMany({
    where: {
      status: 'RUNNING',
      externalRunId: null,
      bootstrapUsedAt: null,
      bootstrapExpiresAt: { lte: now },
      callbackClaim: { usedAt: null, expiresAt: { gt: now } },
      attempt: {
        status: AttemptStatus.RUNNING,
        job: { status: JobStatus.RUNNING, cancelledAt: null },
      },
    },
    select: {
      id: true,
      attemptId: true,
      callbackClaim: { select: { id: true } },
    },
    take: 100,
  });
  const reconciled: string[] = [];
  for (const execution of expired) {
    const claimed = await prisma.execution.updateMany({
      where: {
        attemptId: execution.attemptId,
        status: 'RUNNING',
        externalRunId: null,
        bootstrapUsedAt: null,
        bootstrapExpiresAt: { lte: now },
        callbackClaim: { usedAt: null, expiresAt: { gt: now } },
        attempt: {
          status: AttemptStatus.RUNNING,
          job: { status: JobStatus.RUNNING, cancelledAt: null },
        },
      },
      data: { bootstrapCapabilityHash: null, bootstrapUsedAt: now },
    });
    if (claimed.count !== 1) continue;

    const result = await acceptExecutionCallback(prisma, {
      attemptId: execution.attemptId,
      callbackClaimId: execution.callbackClaim?.id ?? '',
      result: {
        status: 'TIMED_OUT',
        failureCategory: 'TIMEOUT',
        safeSummary:
          'GitHub Actions did not complete secure bootstrap in time.',
        retryable: true,
        artifacts: [],
        finishedAt: now.toISOString(),
      },
      events: [],
      now,
    });
    if (result.accepted) reconciled.push(execution.id);
  }
  return reconciled;
}

export async function acceptExecutionCallbackByExecutionId(
  prisma: PrismaClient,
  input: ExecutionCallbackByExecutionIdInput,
): Promise<ExecutionCallbackResult> {
  const now = input.now ?? new Date();
  const execution = await prisma.execution.findFirst({
    where: {
      id: input.executionId,
      status: 'RUNNING',
      callbackClaim: { usedAt: null, expiresAt: { gt: now } },
      attempt: {
        status: AttemptStatus.RUNNING,
        job: { status: JobStatus.RUNNING, cancelledAt: null },
      },
    },
    select: {
      attemptId: true,
      callbackClaim: { select: { id: true } },
    },
  });

  if (
    !execution?.callbackClaim ||
    ('attemptId' in input && execution.attemptId !== input.attemptId)
  ) {
    return { accepted: false };
  }

  if ('result' in input && input.result) {
    return acceptExecutionCallback(prisma, {
      attemptId: input.attemptId,
      callbackClaimId: execution.callbackClaim.id,
      result: input.result,
      events: input.events,
      now,
    });
  }

  return acceptExecutionCallback(prisma, {
    attemptId: execution.attemptId,
    callbackClaimId: execution.callbackClaim.id,
    status: input.status,
    reason: input.reason,
    events: input.events,
    now,
  });
}

export async function acceptExecutionCallback(
  prisma: PrismaClient,
  input: ExecutionCallbackInput,
): Promise<ExecutionCallbackResult> {
  return acceptExecutionCallbackWithOptions(prisma, input);
}

async function acceptExecutionCallbackWithOptions(
  prisma: PrismaClient,
  input: ExecutionCallbackInput,
  options: CallbackAcceptanceOptions = {},
): Promise<ExecutionCallbackResult> {
  const now = input.now ?? new Date();
  const result = executionResultSchema.parse(resultFromLegacyCallback(input));
  assertCallbackEvents(input.attemptId, result, input.events);

  return prisma.$transaction(async (transaction) => {
    const execution = await transaction.execution.findFirst({
      where: {
        id: options.executionId,
        attemptId: input.attemptId,
        status: 'RUNNING',
        externalRunId: options.externalRunId,
        callbackClaim: {
          id: input.callbackClaimId,
          usedAt: null,
          expiresAt: options.acceptExpiredClaim ? { lte: now } : { gt: now },
        },
      },
      select: {
        id: true,
        attemptId: true,
        cancellationRequest: { select: { id: true } },
      },
    });

    if (!execution) return { accepted: false };

    const attempt = await transaction.jobAttempt.findUniqueOrThrow({
      where: { id: execution.attemptId },
      select: { jobId: true, number: true },
    });
    const retryScheduled =
      !execution.cancellationRequest &&
      shouldScheduleRetry(result, attempt.number);
    const jobStatus = retryScheduled
      ? JobStatus.QUEUED
      : jobStatusForExecution(result.status);
    const attemptStatus = attemptStatusForExecution(result.status);
    const updatedJob = await transaction.job.updateMany({
      where: {
        id: attempt.jobId,
        status: JobStatus.RUNNING,
        currentAttemptNumber: attempt.number,
      },
      data: {
        status: jobStatus,
        cancelledAt: result.status === 'CANCELLED' ? now : undefined,
      },
    });
    if (updatedJob.count !== 1) return { accepted: false };

    const consumedClaim = await transaction.executionCallbackClaim.updateMany({
      where: {
        id: input.callbackClaimId,
        executionId: execution.id,
        usedAt: null,
        expiresAt: options.acceptExpiredClaim ? { lte: now } : { gt: now },
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
      data: {
        status: result.status,
        reason: result.safeSummary,
        failureCategory: result.failureCategory
          ? failureCategories[result.failureCategory]
          : null,
        retryable: result.retryable,
        logProvider: result.logReference
          ? logProviders[result.logReference.provider]
          : null,
        logReference: result.logReference?.reference ?? null,
        logExpiresAt: result.logReference?.expiresAt
          ? new Date(result.logReference.expiresAt)
          : null,
        testSummary: result.testSummary as Prisma.InputJsonValue | undefined,
        reportedAt: new Date(result.finishedAt),
        finishedAt: now,
      },
    });
    await transaction.executionCancellationRequest.updateMany({
      where: { executionId: execution.id },
      data: {
        status:
          result.status === 'CANCELLED'
            ? ExecutionCancellationRequestStatus.COMPLETED
            : ExecutionCancellationRequestStatus.SUPERSEDED,
      },
    });
    await transaction.executionEvent.createMany({
      data: input.events.map((event, index) => ({
        executionId: execution.id,
        sequence: index + 1,
        type: eventTypes[event.type],
        payload: event as Prisma.InputJsonValue,
      })),
    });
    if (result.artifacts.length > 0) {
      await transaction.executionArtifact.createMany({
        data: result.artifacts.map((artifact) => ({
          executionId: execution.id,
          name: artifactNames[artifact.name],
          value: artifact.reference,
        })),
      });
    }

    if (retryScheduled) {
      await transaction.outboxEvent.create({
        data: {
          jobId: attempt.jobId,
          kind: 'JOB_ENQUEUE',
          queueSequence: attempt.number + 1,
          dedupeKey: `job:${attempt.jobId}:retry:${attempt.number + 1}`,
          availableAt: retryAvailableAt(attempt.number, now),
        },
      });
    }

    return retryScheduled
      ? { accepted: true, retryScheduled: true }
      : { accepted: true };
  });
}

export async function getExpiredBoundExecutionCallbacks(
  prisma: PrismaClient,
  now = new Date(),
): Promise<ExpiredExecutionCallback[]> {
  const executions = await prisma.execution.findMany({
    where: {
      status: 'RUNNING',
      externalRunId: { not: null },
      callbackClaim: { usedAt: null, expiresAt: { lte: now } },
      attempt: {
        status: AttemptStatus.RUNNING,
        job: { status: JobStatus.RUNNING, cancelledAt: null },
      },
    },
    select: {
      id: true,
      attemptId: true,
      externalRunId: true,
      callbackClaim: { select: { id: true } },
    },
    take: 100,
  });
  return executions.flatMap((execution) =>
    execution.externalRunId && execution.callbackClaim
      ? [
          {
            executionId: execution.id,
            attemptId: execution.attemptId,
            externalRunId: execution.externalRunId,
          },
        ]
      : [],
  );
}

export async function acceptExpiredExecutionCallback(
  prisma: PrismaClient,
  execution: ExpiredExecutionCallback,
  result: ExecutionResult,
  now = new Date(),
): Promise<ExecutionCallbackResult> {
  const callbackClaim = await prisma.executionCallbackClaim.findFirst({
    where: {
      executionId: execution.executionId,
      usedAt: null,
      expiresAt: { lte: now },
    },
    select: { id: true },
  });
  if (!callbackClaim) return { accepted: false };

  return acceptExecutionCallbackWithOptions(
    prisma,
    {
      attemptId: execution.attemptId,
      callbackClaimId: callbackClaim.id,
      result,
      events: [],
      now,
    },
    {
      executionId: execution.executionId,
      externalRunId: execution.externalRunId,
      acceptExpiredClaim: true,
    },
  );
}
