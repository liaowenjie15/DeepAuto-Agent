import type { ExecutionResult } from '@deepauto/contracts';
import {
  acceptExpiredExecutionCallback,
  getExpiredBoundExecutionCallbacks,
} from '@deepauto/db';
import type { GitHubActionsExecutor } from '@deepauto/runner-manager';
import {
  type ExecuteQueuedGitHubActionsJobDependencies,
  releaseGitHubActionsExecutionConversation,
} from './execute-job';

const defaultIntervalMilliseconds = 1_000;

export type GitHubActionsExecutionReconciler = {
  reconcileOnce(): Promise<number>;
  stop(): void;
};

export type GitHubActionsExecutionReconcilerDependencies = Pick<
  ExecuteQueuedGitHubActionsJobDependencies,
  'prisma' | 'redis'
> & {
  githubActionsExecutor: Pick<GitHubActionsExecutor, 'getStatus'>;
  now?: () => Date;
};

function resultForState(
  state: Awaited<ReturnType<GitHubActionsExecutor['getStatus']>>['state'],
  now: Date,
): ExecutionResult {
  if (state === 'completed') {
    return {
      status: 'COMPLETED',
      safeSummary: 'GitHub Actions completed after the callback deadline.',
      retryable: false,
      artifacts: [],
      finishedAt: now.toISOString(),
    };
  }
  if (state === 'cancelled') {
    return {
      status: 'CANCELLED',
      failureCategory: 'CANCELLED',
      safeSummary: 'GitHub Actions was cancelled after the callback deadline.',
      retryable: false,
      artifacts: [],
      finishedAt: now.toISOString(),
    };
  }
  if (state === 'failed') {
    return {
      status: 'FAILED',
      failureCategory: 'VALIDATION_FAILED',
      safeSummary: 'GitHub Actions failed after the callback deadline.',
      retryable: false,
      artifacts: [],
      finishedAt: now.toISOString(),
    };
  }
  return {
    status: 'TIMED_OUT',
    failureCategory: 'TIMEOUT',
    safeSummary: 'GitHub Actions did not report a terminal result in time.',
    retryable: true,
    artifacts: [],
    finishedAt: now.toISOString(),
  };
}

export function startGitHubActionsExecutionReconciler(
  dependencies: GitHubActionsExecutionReconcilerDependencies,
  intervalMilliseconds = defaultIntervalMilliseconds,
): GitHubActionsExecutionReconciler {
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('GitHub Actions reconciler interval must be positive');
  }
  const now = dependencies.now ?? (() => new Date());
  let reconciling = false;
  const reconcileOnce = async () => {
    if (reconciling) return 0;
    reconciling = true;
    try {
      const expired = await getExpiredBoundExecutionCallbacks(
        dependencies.prisma,
        now(),
      );
      let reconciled = 0;
      for (const execution of expired) {
        let state: Awaited<
          ReturnType<GitHubActionsExecutor['getStatus']>
        >['state'];
        try {
          state = (
            await dependencies.githubActionsExecutor.getStatus({
              executionId: execution.executionId,
              externalRunId: execution.externalRunId,
            })
          ).state;
        } catch {
          state = 'unknown';
        }
        const accepted = await acceptExpiredExecutionCallback(
          dependencies.prisma,
          execution,
          resultForState(state, now()),
          now(),
        );
        if (!accepted.accepted) continue;
        await releaseGitHubActionsExecutionConversation(
          execution.executionId,
          dependencies,
        );
        reconciled += 1;
      }
      return reconciled;
    } finally {
      reconciling = false;
    }
  };
  const timer = setInterval(() => {
    void reconcileOnce().catch(() => undefined);
  }, intervalMilliseconds);
  void reconcileOnce().catch(() => undefined);

  return { reconcileOnce, stop: () => clearInterval(timer) };
}
