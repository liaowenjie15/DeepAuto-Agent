import {
  acceptExecutionCallback,
  beginJobAttempt,
  type ExecutionStatus,
  type PrismaClient,
  releaseConversationClaim,
  startExecution,
  tryClaimConversation,
} from '@deepauto/db';
import {
  type CliHarnessRequest,
  type CliHarnessResult,
  runCliHarness,
} from '@deepauto/runner-manager';
import type IORedis from 'ioredis';

const defaultCallbackTtlMilliseconds = 15 * 60 * 1000;
const maximumCallbackTtlMilliseconds = 60 * 60 * 1000;

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
  status: CliHarnessResult['status'] | 'deferred' | 'skipped' | 'rejected';
  attemptId?: string;
  executionId?: string;
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
