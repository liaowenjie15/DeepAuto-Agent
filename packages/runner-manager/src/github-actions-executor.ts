import type {
  GitHubWorkflowDispatch,
  GitHubWorkflowDispatcher,
} from '@deepauto/github';
import { isRetryableGitHubRequestError } from '@deepauto/github';
import { z } from 'zod';

const githubActionsExecutorConfigSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'Repository must be owner/repository'),
  workflow: z.string().trim().min(1),
  workflowRef: z.string().trim().min(1),
});

const githubActionsExecutionRequestSchema = z.object({
  executionId: z.string().trim().min(1),
});

export type GitHubActionsExecutorConfig = z.input<
  typeof githubActionsExecutorConfigSchema
>;

export type GitHubActionsExecutionRequest = z.input<
  typeof githubActionsExecutionRequestSchema
>;

export type GitHubActionsExecutionResult = {
  executionRef: string;
};

export class ExecutorStartError extends Error {
  override readonly name = 'ExecutorStartError';

  constructor(
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Executor failed before starting the execution',
      { cause },
    );
  }
}

export function isRetryableExecutorStartError(
  error: unknown,
): error is ExecutorStartError {
  return (
    error instanceof Error &&
    error.name === 'ExecutorStartError' &&
    'retryable' in error &&
    error.retryable === true
  );
}

export class GitHubActionsExecutor {
  readonly #configuration: z.infer<typeof githubActionsExecutorConfigSchema>;

  constructor(
    configuration: GitHubActionsExecutorConfig,
    private readonly dispatcher: GitHubWorkflowDispatcher,
  ) {
    this.#configuration =
      githubActionsExecutorConfigSchema.parse(configuration);
  }

  async start(
    request: GitHubActionsExecutionRequest,
  ): Promise<GitHubActionsExecutionResult> {
    const parsedRequest = githubActionsExecutionRequestSchema.parse(request);
    const dispatch: GitHubWorkflowDispatch = {
      repository: this.#configuration.repository,
      workflow: this.#configuration.workflow,
      ref: this.#configuration.workflowRef,
      inputs: { execution_id: parsedRequest.executionId },
    };

    try {
      await this.dispatcher.dispatch(dispatch);
    } catch (error) {
      throw new ExecutorStartError(isRetryableGitHubRequestError(error), error);
    }
    return {
      executionRef: `github-actions:${this.#configuration.repository}:${parsedRequest.executionId}`,
    };
  }
}
