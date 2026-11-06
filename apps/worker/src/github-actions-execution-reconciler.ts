import type { ExecutionResult } from '@deepauto/contracts';
import {
  acceptExpiredExecutionCallback,
  getActiveBoundExecutions,
  getExpiredBoundExecutionCallbacks,
  requestJobCancellation,
} from '@deepauto/db';
import type { GitHubActionsExecutor } from '@deepauto/runner-manager';
import {
  type ExecuteQueuedGitHubActionsJobDependencies,
  renewGitHubActionsExecutionConversation,
} from './execute-job';

const defaultIntervalMilliseconds = 1_000;
const leaseRenewalIntervalMilliseconds = 30_000;

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

export function resultForState(
  state: Awaited<ReturnType<GitHubActionsExecutor['getStatus']>>['state'],
  now: Date,
): ExecutionResult | null {
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
  return null;
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
  let lastLeaseRenewalAt = 0;
  const reconcileOnce = async () => {
    if (reconciling) return 0;
    reconciling = true;
    try {
      const current = now();
      if (
        current.getTime() - lastLeaseRenewalAt >=
        leaseRenewalIntervalMilliseconds
      ) {
        lastLeaseRenewalAt = current.getTime();
        const activeExecutions = await getActiveBoundExecutions(
          dependencies.prisma,
        );
        for (const execution of activeExecutions) {
          try {
            const renewed = await renewGitHubActionsExecutionConversation(
              execution.conversationKey,
              execution.executionId,
              dependencies,
            );
            if (renewed) continue;
          } catch {}
          await requestJobCancellation(dependencies.prisma, {
            jobId: execution.jobId,
            requestedByActorId: execution.actorId,
            now: current,
          });
        }
      }
      const expired = await getExpiredBoundExecutionCallbacks(
        dependencies.prisma,
        current,
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
        const result = resultForState(state, now());
        if (!result) continue;
        const accepted = await acceptExpiredExecutionCallback(
          dependencies.prisma,
          execution,
          result,
          now(),
        );
        if (!accepted.accepted) continue;
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
