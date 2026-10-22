import type {
  GitHubWorkflowController,
  GitHubWorkflowDispatch,
  GitHubWorkflowRun,
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

export type ExecutorExecutionState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type ExecutorExecutionStatus = {
  executionRef: string;
  state: ExecutorExecutionState;
  externalUrl?: string;
};

export type ExecutorAdapter = {
  start(
    request: GitHubActionsExecutionRequest,
  ): Promise<GitHubActionsExecutionResult>;
  getStatus(
    request: GitHubActionsExecutionRequest,
  ): Promise<ExecutorExecutionStatus>;
  cancel(
    request: GitHubActionsExecutionRequest,
  ): Promise<ExecutorExecutionStatus>;
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

function executionRef(repository: string, executionId: string): string {
  return `github-actions:${repository}:${executionId}`;
}

function executionStateForWorkflowRun(
  workflowRun: GitHubWorkflowRun | null,
): ExecutorExecutionState {
  if (!workflowRun) return 'queued';
  if (workflowRun.status === 'queued') return 'queued';
  if (workflowRun.status === 'in_progress') return 'running';
  if (workflowRun.status !== 'completed') return 'unknown';
  if (workflowRun.conclusion === 'success') return 'completed';
  if (workflowRun.conclusion === 'cancelled') return 'cancelled';
  if (
    workflowRun.conclusion === 'failure' ||
    workflowRun.conclusion === 'timed_out'
  ) {
    return 'failed';
  }
  return 'unknown';
}

export class GitHubActionsExecutor implements ExecutorAdapter {
  readonly #configuration: z.infer<typeof githubActionsExecutorConfigSchema>;

  constructor(
    configuration: GitHubActionsExecutorConfig,
    private readonly controller: GitHubWorkflowController,
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
      await this.controller.dispatch(dispatch);
    } catch (error) {
      throw new ExecutorStartError(isRetryableGitHubRequestError(error), error);
    }
    return {
      executionRef: executionRef(
        this.#configuration.repository,
        parsedRequest.executionId,
      ),
    };
  }

  async getStatus(
    request: GitHubActionsExecutionRequest,
  ): Promise<ExecutorExecutionStatus> {
    const parsedRequest = githubActionsExecutionRequestSchema.parse(request);
    const workflowRun = await this.controller.findRun({
      repository: this.#configuration.repository,
      workflow: this.#configuration.workflow,
      executionId: parsedRequest.executionId,
    });
    return {
      executionRef: executionRef(
        this.#configuration.repository,
        parsedRequest.executionId,
      ),
      state: executionStateForWorkflowRun(workflowRun),
      externalUrl: workflowRun?.url,
    };
  }

  async cancel(
    request: GitHubActionsExecutionRequest,
  ): Promise<ExecutorExecutionStatus> {
    const parsedRequest = githubActionsExecutionRequestSchema.parse(request);
    const workflowRun = await this.controller.findRun({
      repository: this.#configuration.repository,
      workflow: this.#configuration.workflow,
      executionId: parsedRequest.executionId,
    });
    const state = executionStateForWorkflowRun(workflowRun);
    if (!workflowRun || (state !== 'queued' && state !== 'running')) {
      return {
        executionRef: executionRef(
          this.#configuration.repository,
          parsedRequest.executionId,
        ),
        state,
        externalUrl: workflowRun?.url,
      };
    }

    await this.controller.cancelRun({
      repository: this.#configuration.repository,
      runId: workflowRun.id,
    });
    return {
      executionRef: executionRef(
        this.#configuration.repository,
        parsedRequest.executionId,
      ),
      state: 'cancelling',
      externalUrl: workflowRun.url,
    };
  }
}
