import {
  ExecutionStatus,
  failExecutionCancellation,
  getExecutionCancellationControl,
  type PrismaClient,
  recordExecutionCancellationAttempt,
  recordExecutionCancellationReconciliationFailure,
  recordExternalExecutionTerminalStatus,
} from '@deepauto/db';
import { isRetryableGitHubRequestError } from '@deepauto/github';
import type {
  ExecutorExecutionStatus,
  GitHubActionsExecutor,
} from '@deepauto/runner-manager';
import type IORedis from 'ioredis';
import { releaseGitHubActionsExecutionConversation } from './execute-job';

const defaultMaximumReconciliationAttempts = 5;

export type ExecutionCancellationControlInput = {
  outboxEventId: string;
  maximumReconciliationAttempts?: number;
};

export type ExecutionCancellationControlDependencies = {
  prisma: PrismaClient;
  redis: IORedis;
  githubActionsExecutor: Pick<GitHubActionsExecutor, 'getStatus' | 'cancel'>;
  now?: () => Date;
};

export type ExecutionCancellationControlResult = {
  status: 'retry' | 'completed' | 'failed' | 'skipped';
};

function assertMaximumReconciliationAttempts(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      'Maximum reconciliation attempts must be a positive integer',
    );
  }
}

function terminalStatusForExecutorState(
  state: ExecutorExecutionStatus['state'],
):
  | typeof ExecutionStatus.COMPLETED
  | typeof ExecutionStatus.FAILED
  | typeof ExecutionStatus.CANCELLED
  | undefined {
  if (state === 'completed') return ExecutionStatus.COMPLETED;
  if (state === 'failed') return ExecutionStatus.FAILED;
  if (state === 'cancelled') return ExecutionStatus.CANCELLED;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'GitHub Actions execution control failed without an error message';
}

async function finalizeExternalTerminalState(
  executionId: string,
  status: Exclude<ReturnType<typeof terminalStatusForExecutorState>, undefined>,
  dependencies: ExecutionCancellationControlDependencies,
  now: Date,
): Promise<ExecutionCancellationControlResult> {
  const accepted = await recordExternalExecutionTerminalStatus(
    dependencies.prisma,
    {
      executionId,
      status,
      reason: `GitHub Actions status reconciliation observed ${status}`,
      now,
    },
  );
  if (accepted) {
    await releaseGitHubActionsExecutionConversation(executionId, dependencies);
  }
  return { status: accepted ? 'completed' : 'skipped' };
}

async function failAfterExhaustedReconciliation(
  cancellationRequestId: string,
  executionId: string,
  dependencies: ExecutionCancellationControlDependencies,
  now: Date,
): Promise<ExecutionCancellationControlResult> {
  await recordExecutionCancellationReconciliationFailure(dependencies.prisma, {
    cancellationRequestId,
    executionId,
    reason:
      'GitHub Actions cancellation reconciliation exceeded its attempt limit',
    now,
  });
  return { status: 'failed' };
}

async function handleExecutionControlError(
  control: NonNullable<
    Awaited<ReturnType<typeof getExecutionCancellationControl>>
  >,
  current: ExecutorExecutionStatus | undefined,
  error: unknown,
  maximumReconciliationAttempts: number,
  dependencies: ExecutionCancellationControlDependencies,
  now: Date,
): Promise<ExecutionCancellationControlResult> {
  const reason = errorMessage(error);
  const recorded = await recordExecutionCancellationAttempt(
    dependencies.prisma,
    {
      cancellationRequestId: control.cancellationRequestId,
      executionId: control.executionId,
      status: control.status,
      externalRunId: current?.externalRunId,
      externalUrl: current?.externalUrl,
      lastError: reason,
      now,
    },
  );
  if (!recorded) return { status: 'skipped' };

  if (!isRetryableGitHubRequestError(error)) {
    await failExecutionCancellation(dependencies.prisma, {
      cancellationRequestId: control.cancellationRequestId,
      executionId: control.executionId,
      reason,
      now,
    });
    return { status: 'failed' };
  }
  if (control.attemptCount + 1 >= maximumReconciliationAttempts) {
    return failAfterExhaustedReconciliation(
      control.cancellationRequestId,
      control.executionId,
      dependencies,
      now,
    );
  }
  return { status: 'retry' };
}

export async function processExecutionCancellationControl(
  input: ExecutionCancellationControlInput,
  dependencies: ExecutionCancellationControlDependencies,
): Promise<ExecutionCancellationControlResult> {
  const maximumReconciliationAttempts =
    input.maximumReconciliationAttempts ?? defaultMaximumReconciliationAttempts;
  assertMaximumReconciliationAttempts(maximumReconciliationAttempts);

  const control = await getExecutionCancellationControl(
    dependencies.prisma,
    input.outboxEventId,
  );
  if (!control) return { status: 'skipped' };

  const now = dependencies.now?.() ?? new Date();
  const request = {
    executionId: control.executionId,
    externalRunId: control.externalRunId ?? undefined,
  };
  let current: ExecutorExecutionStatus;
  try {
    current = await dependencies.githubActionsExecutor.getStatus(request);
  } catch (error) {
    return handleExecutionControlError(
      control,
      undefined,
      error,
      maximumReconciliationAttempts,
      dependencies,
      now,
    );
  }

  const terminalStatus = terminalStatusForExecutorState(current.state);
  if (terminalStatus) {
    await recordExecutionCancellationAttempt(dependencies.prisma, {
      cancellationRequestId: control.cancellationRequestId,
      executionId: control.executionId,
      status: control.status,
      externalRunId: current.externalRunId,
      externalUrl: current.externalUrl,
      lastError: null,
      now,
    });
    return finalizeExternalTerminalState(
      control.executionId,
      terminalStatus,
      dependencies,
      now,
    );
  }

  if (control.status === 'DISPATCHED') {
    const recorded = await recordExecutionCancellationAttempt(
      dependencies.prisma,
      {
        cancellationRequestId: control.cancellationRequestId,
        executionId: control.executionId,
        status: 'DISPATCHED',
        externalRunId: current.externalRunId,
        externalUrl: current.externalUrl,
        lastError: null,
        now,
      },
    );
    if (!recorded) return { status: 'skipped' };
    if (control.attemptCount + 1 >= maximumReconciliationAttempts) {
      return failAfterExhaustedReconciliation(
        control.cancellationRequestId,
        control.executionId,
        dependencies,
        now,
      );
    }
    return { status: 'retry' };
  }

  let cancellation: ExecutorExecutionStatus;
  try {
    cancellation = await dependencies.githubActionsExecutor.cancel({
      executionId: control.executionId,
      externalRunId: current.externalRunId,
    });
  } catch (error) {
    return handleExecutionControlError(
      control,
      current,
      error,
      maximumReconciliationAttempts,
      dependencies,
      now,
    );
  }

  const cancellationTerminalStatus = terminalStatusForExecutorState(
    cancellation.state,
  );
  const recorded = await recordExecutionCancellationAttempt(
    dependencies.prisma,
    {
      cancellationRequestId: control.cancellationRequestId,
      executionId: control.executionId,
      status: cancellation.state === 'cancelling' ? 'DISPATCHED' : 'REQUESTED',
      externalRunId: cancellation.externalRunId ?? current.externalRunId,
      externalUrl: cancellation.externalUrl ?? current.externalUrl,
      lastError: null,
      now,
    },
  );
  if (!recorded) return { status: 'skipped' };
  if (cancellationTerminalStatus) {
    return finalizeExternalTerminalState(
      control.executionId,
      cancellationTerminalStatus,
      dependencies,
      now,
    );
  }
  if (control.attemptCount + 1 >= maximumReconciliationAttempts) {
    return failAfterExhaustedReconciliation(
      control.cancellationRequestId,
      control.executionId,
      dependencies,
      now,
    );
  }
  return { status: 'retry' };
}
