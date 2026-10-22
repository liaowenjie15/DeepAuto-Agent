import {
  acceptExecutionCallback,
  beginJobAttempt,
  type ExecutionStatus,
  isJobAtConversationHead,
  type PrismaClient,
  releaseConversationClaim,
  requeueFailedJob,
  startExecution,
  transferConversationClaim,
  tryClaimConversation,
} from '@deepauto/db';
import {
  type CliHarnessRequest,
  type CliHarnessResult,
  type GitHubActionsExecutor,
  isRetryableExecutorStartError,
  runCliHarness,
} from '@deepauto/runner-manager';
import type IORedis from 'ioredis';

const defaultCallbackTtlMilliseconds = 15 * 60 * 1000;
const maximumCallbackTtlMilliseconds = 60 * 60 * 1000;
const defaultMaximumInfrastructureAttempts = 1;

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
    | 'skipped'
    | 'rejected';
  attemptId?: string;
  executionId?: string;
  executionRef?: string;
};

export type ExecuteQueuedGitHubActionsJobInput = Pick<
  ExecuteQueuedJobInput,
  'jobId' | 'workerId' | 'callbackTtlMilliseconds'
> & {
  maximumInfrastructureAttempts?: number;
};

export type ExecuteQueuedGitHubActionsJobDependencies = Omit<
  ExecuteQueuedJobDependencies,
  'runHarness'
> & {
  githubActionsExecutor: Pick<GitHubActionsExecutor, 'start'>;
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

function assertMaximumInfrastructureAttempts(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      'Maximum infrastructure attempts must be a positive integer',
    );
  }
}

async function failExecutionBeforeDispatch(
  prisma: PrismaClient,
  execution: { id: string; callbackClaim: { id: string } | null },
  attemptId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const callback = await acceptExecutionCallback(prisma, {
    attemptId,
    callbackClaimId: execution.callbackClaim?.id ?? '',
    status: 'FAILED',
    reason,
    events: [],
    now,
  });
  return callback.accepted;
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
      status: toExecutionStatus(result.status),
      reason: result.reason,
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
      status: result.status,
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
  const maximumInfrastructureAttempts =
    input.maximumInfrastructureAttempts ?? defaultMaximumInfrastructureAttempts;
  assertMaximumInfrastructureAttempts(maximumInfrastructureAttempts);

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
    const execution = await startExecution(
      dependencies.prisma,
      {
        attemptId: attempt.id,
        callbackExpiresAt: new Date(now().getTime() + callbackTtlMilliseconds),
      },
      now(),
    );
    const lockTransferred = await transferConversationClaim(
      dependencies.redis,
      job.conversationKey,
      input.workerId,
      execution.id,
      callbackTtlMilliseconds,
    );
    if (!lockTransferred) {
      const accepted = await failExecutionBeforeDispatch(
        dependencies.prisma,
        execution,
        attempt.id,
        'Worker lost the conversation claim before GitHub Actions dispatch',
        now(),
      );
      return {
        status: accepted ? 'failed' : 'rejected',
        attemptId: attempt.id,
        executionId: execution.id,
      };
    }

    conversationOwner = execution.id;
    try {
      const started = await dependencies.githubActionsExecutor.start({
        executionId: execution.id,
      });
      releaseConversation = false;
      return {
        status: 'dispatched',
        attemptId: attempt.id,
        executionId: execution.id,
        executionRef: started.executionRef,
      };
    } catch (error) {
      const accepted = await failExecutionBeforeDispatch(
        dependencies.prisma,
        execution,
        attempt.id,
        'GitHub Actions dispatch failed before the execution started',
        now(),
      );
      const retried =
        accepted &&
        isRetryableExecutorStartError(error) &&
        attempt.number < maximumInfrastructureAttempts &&
        (await requeueFailedJob(dependencies.prisma, input.jobId));
      return {
        status: retried ? 'retrying' : accepted ? 'failed' : 'rejected',
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
