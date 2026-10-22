import { DelayedError, type Processor } from 'bullmq';
import {
  type ExecuteQueuedGitHubActionsJobDependencies,
  executeQueuedGitHubActionsJob,
  type QueuedJobExecutionResult,
} from './execute-job';

const defaultConversationDeferMilliseconds = 1_000;

export type GitHubActionsQueueData = {
  jobId: string;
};

export type GitHubActionsQueueProcessorOptions = {
  workerId: string;
  callbackTtlMilliseconds?: number;
  conversationDeferMilliseconds?: number;
  now?: () => number;
};

type ExecuteGitHubActionsJob = typeof executeQueuedGitHubActionsJob;

function assertConversationDeferMilliseconds(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Conversation defer delay must be a positive integer');
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
  const now = options.now ?? Date.now;

  return async (job, token) => {
    const result = await execute(
      {
        jobId: job.data.jobId,
        workerId: options.workerId,
        callbackTtlMilliseconds: options.callbackTtlMilliseconds,
      },
      dependencies,
    );
    if (result.status !== 'deferred') return result;

    await job.moveToDelayed(now() + conversationDeferMilliseconds, token);
    throw new DelayedError(
      'Conversation is still occupied or has an earlier Job',
    );
  };
}
