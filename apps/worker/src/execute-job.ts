import {
  acceptExecutionCallback,
  beginJobAttempt,
  createExecutionBootstrapCapability,
  type ExecutionStatus,
  isJobAtConversationHead,
  type PrismaClient,
  releaseConversationClaim,
  startExecution,
  transferConversationClaim,
  tryClaimConversation,
} from '@deepauto/db';
import {
  type CliHarnessRequest,
  type CliHarnessResult,
  type GitHubActionsExecutor,
  isRetryableExecutorStartError,
  normalizeCliHarnessResult,
  runCliHarness,
} from '@deepauto/runner-manager';
import type IORedis from 'ioredis';

const defaultCallbackTtlMilliseconds = 15 * 60 * 1000;
const maximumCallbackTtlMilliseconds = 60 * 60 * 1000;
const bootstrapCapabilityTtlMilliseconds = 60_000;
const callbackDeliverySlackMilliseconds = 2 * 60 * 1000;

const executionStatusByHarnessStatus = {
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  timed_out: 'TIMED_OUT',
} as const satisfies Record<CliHarnessResult['status'], ExecutionStatus>;

export type RunHarness = (
  request: CliHarnessRequest,
) => Promise<CliHarnessResult>;

export type ExecuteQueuedJobInput = Omit<
  CliHarnessRequest,
  'attemptId' | 'jobId'
> & {
  jobId: string;
  workerId: string;
  callbackTtlMilliseconds?: number;
};

export type ExecuteQueuedJobDependencies = {
  prisma: PrismaClient;
  redis: IORedis;
  runHarness?: RunHarness;
  now?: () => Date;
};

export type QueuedJobExecutionResult = {
  status:
    | CliHarnessResult['status']
    | 'dispatched'
    | 'deferred'
    | 'retrying'
    | 'retry_scheduled'
    | 'skipped'
    | 'rejected';
  attemptId?: string;
  executionId?: string;
  executionRef?: string;
};

export type ExecuteQueuedGitHubActionsJobInput = Pick<
  ExecuteQueuedJobInput,
  'jobId' | 'workerId' | 'callbackTtlMilliseconds'
>;

export type ExecuteQueuedGitHubActionsJobDependencies = Omit<
  ExecuteQueuedJobDependencies,
  'runHarness'
> & {
  githubActionsExecutor: Pick<GitHubActionsExecutor, 'start' | 'getStatus'>;
};

export function toExecutionStatus(
  status: CliHarnessResult['status'],
): ExecutionStatus {
  return executionStatusByHarnessStatus[status];
}

function assertCallbackTtl(value: number): void {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximumCallbackTtlMilliseconds
  ) {
    throw new Error('Worker callback TTL must be between 1ms and one hour');
  }
}

async function failExecutionBeforeDispatch(
  prisma: PrismaClient,
  execution: { id: string; callbackClaim: { id: string } | null },
  attemptId: string,
  reason: string,
  now: Date,
): Promise<{ accepted: boolean; retryScheduled?: true }> {
  return acceptExecutionCallback(prisma, {
    attemptId,
    callbackClaimId: execution.callbackClaim?.id ?? '',
    result: {
      status: 'FAILED',
      failureCategory: 'INFRASTRUCTURE_FAILED',
      safeSummary: reason,
      retryable: true,
      artifacts: [],
      finishedAt: now.toISOString(),
    },
    events: [],
    now,
  });
}

export async function executeQueuedJob(
  input: ExecuteQueuedJobInput,
  dependencies: ExecuteQueuedJobDependencies,
): Promise<QueuedJobExecutionResult> {
  const callbackTtlMilliseconds =
    input.callbackTtlMilliseconds ?? defaultCallbackTtlMilliseconds;
  assertCallbackTtl(callbackTtlMilliseconds);

  const job = await dependencies.prisma.job.findUnique({
    where: { id: input.jobId },
    select: { conversationKey: true },
  });
  if (!job) return { status: 'skipped' };

  const ownsConversation = await tryClaimConversation(
    dependencies.redis,
    job.conversationKey,
    input.workerId,
  );
  if (!ownsConversation) return { status: 'deferred' };

  try {
    if (
      !(await isJobAtConversationHead(
        dependencies.prisma,
        input.jobId,
        job.conversationKey,
      ))
    ) {
      return { status: 'deferred' };
    }

    const attempt = await beginJobAttempt(dependencies.prisma, input.jobId);
    if (!attempt) return { status: 'skipped' };

    const now = dependencies.now ?? (() => new Date());
    const execution = await startExecution(
      dependencies.prisma,
      {
        attemptId: attempt.id,
        callbackExpiresAt: new Date(now().getTime() + callbackTtlMilliseconds),
      },
      now(),
    );
    const {
      callbackTtlMilliseconds: _,
      jobId,
      workerId,
      ...harnessRequest
    } = input;
    const runHarness = dependencies.runHarness ?? runCliHarness;
    let result: CliHarnessResult;

    try {
      result = await runHarness({
        ...harnessRequest,
        attemptId: attempt.id,
        jobId,
      });
    } catch {
      result = {
        status: 'failed',
        events: [],
        artifacts: {},
        reason: 'CLI harness failed before producing an execution result',
      };
    }

    const callback = await acceptExecutionCallback(dependencies.prisma, {
      attemptId: attempt.id,
      callbackClaimId: execution.callbackClaim?.id ?? '',
      result: normalizeCliHarnessResult(result, { finishedAt: now() }),
      events: result.events,
      now: now(),
    });
    if (!callback.accepted) {
      return {
        status: 'rejected',
        attemptId: attempt.id,
        executionId: execution.id,
      };
    }

    return {
      status: callback.retryScheduled ? 'retry_scheduled' : result.status,
      attemptId: attempt.id,
      executionId: execution.id,
    };
  } finally {
    await releaseConversationClaim(
      dependencies.redis,
      job.conversationKey,
      input.workerId,
    );
  }
}

export async function executeQueuedGitHubActionsJob(
  input: ExecuteQueuedGitHubActionsJobInput,
  dependencies: ExecuteQueuedGitHubActionsJobDependencies,
): Promise<QueuedJobExecutionResult> {
  const callbackTtlMilliseconds =
    input.callbackTtlMilliseconds ?? defaultCallbackTtlMilliseconds;
  assertCallbackTtl(callbackTtlMilliseconds);
  const job = await dependencies.prisma.job.findUnique({
    where: { id: input.jobId },
    select: { conversationKey: true },
  });
  if (!job) return { status: 'skipped' };

  const ownsConversation = await tryClaimConversation(
    dependencies.redis,
    job.conversationKey,
    input.workerId,
    callbackTtlMilliseconds,
  );
  if (!ownsConversation) return { status: 'deferred' };

  let conversationOwner = input.workerId;
  let releaseConversation = true;
  try {
    if (
      !(await isJobAtConversationHead(
        dependencies.prisma,
        input.jobId,
        job.conversationKey,
      ))
    ) {
      return { status: 'deferred' };
    }

    const attempt = await beginJobAttempt(dependencies.prisma, input.jobId);
    if (!attempt) return { status: 'skipped' };

    const now = dependencies.now ?? (() => new Date());
    const bootstrapCapability = createExecutionBootstrapCapability();
    const callbackExpiresAt = new Date(
      now().getTime() +
        callbackTtlMilliseconds +
        callbackDeliverySlackMilliseconds,
    );
    const execution = await startExecution(
      dependencies.prisma,
      {
        attemptId: attempt.id,
        callbackExpiresAt,
        bootstrapCapabilityHash: bootstrapCapability.hash,
        bootstrapExpiresAt: new Date(
          now().getTime() + bootstrapCapabilityTtlMilliseconds,
        ),
      },
      now(),
    );
    const lockTransferred = await transferConversationClaim(
      dependencies.redis,
      job.conversationKey,
      input.workerId,
      execution.id,
      callbackTtlMilliseconds + callbackDeliverySlackMilliseconds,
    );
    if (!lockTransferred) {
      const callback = await failExecutionBeforeDispatch(
        dependencies.prisma,
        execution,
        attempt.id,
        'Worker lost the conversation claim before GitHub Actions dispatch',
        now(),
      );
      return {
        status: callback.retryScheduled
          ? 'retry_scheduled'
          : callback.accepted
            ? 'failed'
            : 'rejected',
        attemptId: attempt.id,
        executionId: execution.id,
      };
    }

    conversationOwner = execution.id;
    try {
      const started = await dependencies.githubActionsExecutor.start({
        executionId: execution.id,
        bootstrapCapability: bootstrapCapability.value,
      });
      releaseConversation = false;
      return {
        status: 'dispatched',
        attemptId: attempt.id,
        executionId: execution.id,
        executionRef: started.executionRef,
      };
    } catch (error) {
      const retryable = isRetryableExecutorStartError(error);
      const callback = await acceptExecutionCallback(dependencies.prisma, {
        attemptId: attempt.id,
        callbackClaimId: execution.callbackClaim?.id ?? '',
        result: {
          status: 'FAILED',
          failureCategory: retryable
            ? 'INFRASTRUCTURE_FAILED'
            : 'POLICY_REJECTED',
          safeSummary: retryable
            ? 'The execution environment was unavailable and will retry.'
            : 'GitHub Actions rejected the execution dispatch.',
          retryable,
          artifacts: [],
          finishedAt: now().toISOString(),
        },
        events: [],
        now: now(),
      });
      const accepted = callback.accepted;
      const retryScheduled = callback.retryScheduled;
      return {
        status: retryScheduled
          ? 'retry_scheduled'
          : accepted
            ? 'failed'
            : 'rejected',
        attemptId: attempt.id,
        executionId: execution.id,
      };
    }
  } finally {
    if (releaseConversation) {
      await releaseConversationClaim(
        dependencies.redis,
        job.conversationKey,
        conversationOwner,
      );
    }
  }
}

export async function releaseGitHubActionsExecutionConversation(
  executionId: string,
  dependencies: Pick<ExecuteQueuedJobDependencies, 'prisma' | 'redis'>,
): Promise<boolean> {
  const execution = await dependencies.prisma.execution.findUnique({
    where: { id: executionId },
    select: {
      attempt: { select: { job: { select: { conversationKey: true } } } },
    },
  });
  if (!execution) return false;

  return releaseConversationClaim(
    dependencies.redis,
    execution.attempt.job.conversationKey,
    executionId,
  );
}
