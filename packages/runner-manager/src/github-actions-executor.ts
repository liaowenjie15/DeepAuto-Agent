import { resolveExecutionCapability } from '@deepauto/contracts';
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
  repositoryId: z.string().trim().min(1, 'Repository ID is required'),
  workflow: z.string().trim().min(1),
  workflowRef: z.string().trim().min(1),
});

const githubActionsExecutionRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  bootstrapCapability: z.string().trim().min(43).max(128).optional(),
  externalRunId: z.bigint().positive().optional(),
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
  externalRunId?: bigint;
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

function toGitHubRunId(externalRunId: bigint): number {
  const runId = Number(externalRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('GitHub workflow run ID must be a safe positive integer');
  }
  return runId;
}

export class GitHubActionsExecutor implements ExecutorAdapter {
  readonly #configuration: z.infer<typeof githubActionsExecutorConfigSchema>;

  constructor(
    configuration: GitHubActionsExecutorConfig,
    private readonly controller: GitHubWorkflowController,
  ) {
    this.#configuration =
      githubActionsExecutorConfigSchema.parse(configuration);
    const capability = resolveExecutionCapability();
    if (
      this.#configuration.workflow !== capability.workflow ||
      this.#configuration.workflowRef !== capability.workflowRef
    ) {
      throw new Error(
        `GitHub Actions workflow is not registered: ${this.#configuration.workflow}@${this.#configuration.workflowRef}`,
      );
    }
  }

  isConfiguredForRepository(repositoryId: string): boolean {
    return this.#configuration.repositoryId === repositoryId;
  }

  async start(
    request: GitHubActionsExecutionRequest,
  ): Promise<GitHubActionsExecutionResult> {
    const parsedRequest = githubActionsExecutionRequestSchema.parse(request);
    const dispatch: GitHubWorkflowDispatch = {
      repository: this.#configuration.repository,
      workflow: this.#configuration.workflow,
      ref: this.#configuration.workflowRef,
      inputs: {
        execution_id: parsedRequest.executionId,
        ...(parsedRequest.bootstrapCapability
          ? { bootstrap_capability: parsedRequest.bootstrapCapability }
          : {}),
      },
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
    const workflowRun = parsedRequest.externalRunId
      ? await this.controller.getRun({
          repository: this.#configuration.repository,
          runId: toGitHubRunId(parsedRequest.externalRunId),
        })
      : null;
    return {
      executionRef: executionRef(
        this.#configuration.repository,
        parsedRequest.executionId,
      ),
      state: executionStateForWorkflowRun(workflowRun),
      externalRunId: workflowRun ? BigInt(workflowRun.id) : undefined,
      externalUrl: workflowRun?.url,
    };
  }

  async cancel(
    request: GitHubActionsExecutionRequest,
  ): Promise<ExecutorExecutionStatus> {
    const parsedRequest = githubActionsExecutionRequestSchema.parse(request);
    const workflowRun = parsedRequest.externalRunId
      ? await this.controller.getRun({
          repository: this.#configuration.repository,
          runId: toGitHubRunId(parsedRequest.externalRunId),
        })
      : null;
    const state = executionStateForWorkflowRun(workflowRun);
    if (!workflowRun || (state !== 'queued' && state !== 'running')) {
      return {
        executionRef: executionRef(
          this.#configuration.repository,
          parsedRequest.executionId,
        ),
        state,
        externalRunId: workflowRun ? BigInt(workflowRun.id) : undefined,
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
      externalRunId: BigInt(workflowRun.id),
      externalUrl: workflowRun.url,
    };
  }
}
