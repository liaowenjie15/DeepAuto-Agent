import { DelayedError, type Processor } from 'bullmq';
import {
  type ExecuteQueuedGitHubActionsJobDependencies,
  executeQueuedGitHubActionsJob,
  type QueuedJobExecutionResult,
} from './execute-job';

const defaultConversationDeferMilliseconds = 1_000;
const defaultInfrastructureRetryMilliseconds = 5_000;
const defaultMaximumInfrastructureAttempts = 3;

export type GitHubActionsQueueData = {
  jobId: string;
};

export type GitHubActionsQueueProcessorOptions = {
  workerId: string;
  callbackTtlMilliseconds?: number;
  conversationDeferMilliseconds?: number;
  infrastructureRetryMilliseconds?: number;
  maximumInfrastructureAttempts?: number;
  now?: () => number;
};

type ExecuteGitHubActionsJob = typeof executeQueuedGitHubActionsJob;

function assertConversationDeferMilliseconds(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Conversation defer delay must be a positive integer');
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function createGitHubActionsQueueProcessor(
  options: GitHubActionsQueueProcessorOptions,
  dependencies: ExecuteQueuedGitHubActionsJobDependencies,
  execute = executeQueuedGitHubActionsJob as ExecuteGitHubActionsJob,
): Processor<GitHubActionsQueueData, QueuedJobExecutionResult, 'execute'> {
  const conversationDeferMilliseconds =
    options.conversationDeferMilliseconds ??
    defaultConversationDeferMilliseconds;
  assertConversationDeferMilliseconds(conversationDeferMilliseconds);
  const infrastructureRetryMilliseconds =
    options.infrastructureRetryMilliseconds ??
    defaultInfrastructureRetryMilliseconds;
  const maximumInfrastructureAttempts =
    options.maximumInfrastructureAttempts ??
    defaultMaximumInfrastructureAttempts;
  assertPositiveInteger(
    infrastructureRetryMilliseconds,
    'Infrastructure retry delay',
  );
  assertPositiveInteger(
    maximumInfrastructureAttempts,
    'Maximum infrastructure attempts',
  );
  const now = options.now ?? Date.now;

  return async (job, token) => {
    const result = await execute(
      {
        jobId: job.data.jobId,
        workerId: options.workerId,
        callbackTtlMilliseconds: options.callbackTtlMilliseconds,
        maximumInfrastructureAttempts,
      },
      dependencies,
    );
    if (result.status !== 'deferred' && result.status !== 'retrying') {
      return result;
    }

    const delay =
      result.status === 'retrying'
        ? infrastructureRetryMilliseconds
        : conversationDeferMilliseconds;
    await job.moveToDelayed(now() + delay, token);
    throw new DelayedError(
      result.status === 'retrying'
        ? 'A retryable infrastructure failure delayed the Job'
        : 'Conversation is still occupied or has an earlier Job',
    );
  };
}
