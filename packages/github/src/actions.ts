import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

const githubApiUrl = 'https://api.github.com';

const repositorySchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/, 'Repository must be owner/repository');

const appCredentialsSchema = z.object({
  appId: z.string().trim().min(1),
  installationId: z.string().trim().min(1),
  privateKey: z.string().trim().min(1),
});

const installationTokenResponseSchema = z.object({
  token: z.string().trim().min(1),
  expires_at: z.iso.datetime(),
});

const workflowDispatchSchema = z.object({
  repository: repositorySchema,
  workflow: z.string().trim().min(1),
  ref: z.string().trim().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
});

const workflowRunLookupSchema = z.object({
  repository: repositorySchema,
  workflow: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
});

const workflowRunCancellationSchema = z.object({
  repository: repositorySchema,
  runId: z.number().int().positive(),
});

const workflowRunSchema = z.object({
  id: z.number().int().positive(),
  status: z.string().trim().min(1),
  conclusion: z.string().trim().min(1).nullable(),
  display_title: z.string().trim().min(1),
  html_url: z.url(),
});

const workflowRunsResponseSchema = z.object({
  workflow_runs: z.array(workflowRunSchema),
});

export type GitHubAppCredentials = z.infer<typeof appCredentialsSchema>;
export type GitHubWorkflowDispatch = z.input<typeof workflowDispatchSchema>;
export type GitHubWorkflowRunLookup = z.input<typeof workflowRunLookupSchema>;
export type GitHubWorkflowRunCancellation = z.input<
  typeof workflowRunCancellationSchema
>;
export type GitHubWorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  url: string;
};

export type GitHubFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GitHubInstallationAccessToken = {
  token: string;
  expiresAt: Date;
};

export type GitHubAppClientOptions = {
  fetch?: GitHubFetch;
  now?: () => Date;
  apiUrl?: string;
};

export type GitHubWorkflowDispatcher = {
  dispatch(input: GitHubWorkflowDispatch): Promise<void>;
};

export type GitHubWorkflowController = GitHubWorkflowDispatcher & {
  findRun(input: GitHubWorkflowRunLookup): Promise<GitHubWorkflowRun | null>;
  getRun(input: GitHubWorkflowRunCancellation): Promise<GitHubWorkflowRun>;
  cancelRun(input: GitHubWorkflowRunCancellation): Promise<void>;
};

export class GitHubRequestError extends Error {
  override readonly name = 'GitHubRequestError';

  constructor(
    readonly operation: string,
    readonly status: number,
    statusText: string,
  ) {
    super(`GitHub ${operation} failed with HTTP ${status} ${statusText}`);
  }
}

export function isRetryableGitHubRequestError(error: unknown): boolean {
  return (
    error instanceof GitHubRequestError &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
  );
}

function apiUrl(options: GitHubAppClientOptions): string {
  return (options.apiUrl ?? githubApiUrl).replace(/\/$/, '');
}

function failGitHubRequest(response: Response, operation: string): Error {
  return new GitHubRequestError(
    operation,
    response.status,
    response.statusText,
  );
}

export async function createGitHubAppJwt(
  credentials: GitHubAppCredentials,
  options: Pick<GitHubAppClientOptions, 'now'> = {},
): Promise<string> {
  const parsed = appCredentialsSchema.parse(credentials);
  const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1_000);
  const privateKey = await importPKCS8(parsed.privateKey, 'RS256');

  return new SignJWT()
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(parsed.appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(privateKey);
}

export async function createGitHubInstallationAccessToken(
  credentials: GitHubAppCredentials,
  repository: string,
  options: GitHubAppClientOptions = {},
): Promise<GitHubInstallationAccessToken> {
  const parsedCredentials = appCredentialsSchema.parse(credentials);
  const parsedRepository = repositorySchema.parse(repository);
  const request = options.fetch ?? fetch;
  const jwt = await createGitHubAppJwt(parsedCredentials, options);
  const response = await request(
    `${apiUrl(options)}/app/installations/${parsedCredentials.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        repositories: [parsedRepository.split('/')[1]],
        permissions: {
          actions: 'write',
          contents: 'write',
          pull_requests: 'write',
        },
      }),
    },
  );
  if (!response.ok) {
    throw failGitHubRequest(response, 'installation token request');
  }

  const payload = installationTokenResponseSchema.parse(await response.json());
  return { token: payload.token, expiresAt: new Date(payload.expires_at) };
}

export async function dispatchGitHubWorkflow(
  accessToken: string,
  dispatch: GitHubWorkflowDispatch,
  options: Omit<GitHubAppClientOptions, 'now'> = {},
): Promise<void> {
  const parsedToken = z.string().trim().min(1).parse(accessToken);
  const parsedDispatch = workflowDispatchSchema.parse(dispatch);
  const request = options.fetch ?? fetch;
  const response = await request(
    `${apiUrl(options)}/repos/${parsedDispatch.repository}/actions/workflows/${encodeURIComponent(parsedDispatch.workflow)}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${parsedToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: parsedDispatch.ref,
        inputs: parsedDispatch.inputs,
      }),
    },
  );
  if (!response.ok) throw failGitHubRequest(response, 'workflow dispatch');
}

function workflowRunTitle(executionId: string): string {
  return `DeepAuto execution ${executionId}`;
}

export async function findGitHubWorkflowRun(
  accessToken: string,
  lookup: GitHubWorkflowRunLookup,
  options: Omit<GitHubAppClientOptions, 'now'> = {},
): Promise<GitHubWorkflowRun | null> {
  const parsedToken = z.string().trim().min(1).parse(accessToken);
  const parsedLookup = workflowRunLookupSchema.parse(lookup);
  const request = options.fetch ?? fetch;
  const search = new URLSearchParams({
    event: 'workflow_dispatch',
    per_page: '100',
  });
  const response = await request(
    `${apiUrl(options)}/repos/${parsedLookup.repository}/actions/workflows/${encodeURIComponent(parsedLookup.workflow)}/runs?${search}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${parsedToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) throw failGitHubRequest(response, 'workflow run lookup');

  const workflowRun = workflowRunsResponseSchema
    .parse(await response.json())
    .workflow_runs.find(
      (run) => run.display_title === workflowRunTitle(parsedLookup.executionId),
    );
  if (!workflowRun) return null;

  return {
    id: workflowRun.id,
    status: workflowRun.status,
    conclusion: workflowRun.conclusion,
    url: workflowRun.html_url,
  };
}

export async function getGitHubWorkflowRun(
  accessToken: string,
  lookup: GitHubWorkflowRunCancellation,
  options: Omit<GitHubAppClientOptions, 'now'> = {},
): Promise<GitHubWorkflowRun> {
  const parsedToken = z.string().trim().min(1).parse(accessToken);
  const parsedLookup = workflowRunCancellationSchema.parse(lookup);
  const request = options.fetch ?? fetch;
  const response = await request(
    `${apiUrl(options)}/repos/${parsedLookup.repository}/actions/runs/${parsedLookup.runId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${parsedToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) throw failGitHubRequest(response, 'workflow run lookup');

  const workflowRun = workflowRunSchema.parse(await response.json());
  return {
    id: workflowRun.id,
    status: workflowRun.status,
    conclusion: workflowRun.conclusion,
    url: workflowRun.html_url,
  };
}

export async function cancelGitHubWorkflowRun(
  accessToken: string,
  cancellation: GitHubWorkflowRunCancellation,
  options: Omit<GitHubAppClientOptions, 'now'> = {},
): Promise<void> {
  const parsedToken = z.string().trim().min(1).parse(accessToken);
  const parsedCancellation = workflowRunCancellationSchema.parse(cancellation);
  const request = options.fetch ?? fetch;
  const response = await request(
    `${apiUrl(options)}/repos/${parsedCancellation.repository}/actions/runs/${parsedCancellation.runId}/cancel`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${parsedToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok)
    throw failGitHubRequest(response, 'workflow run cancellation');
}

export function createGitHubAppWorkflowDispatcher(
  credentials: GitHubAppCredentials,
  options: GitHubAppClientOptions = {},
): GitHubWorkflowController {
  return createGitHubAppWorkflowController(credentials, options);
}

export function createGitHubAppWorkflowController(
  credentials: GitHubAppCredentials,
  options: GitHubAppClientOptions = {},
): GitHubWorkflowController {
  return {
    async dispatch(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
      );
      await dispatchGitHubWorkflow(accessToken.token, input, options);
    },
    async findRun(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
      );
      return findGitHubWorkflowRun(accessToken.token, input, options);
    },
    async getRun(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
      );
      return getGitHubWorkflowRun(accessToken.token, input, options);
    },
    async cancelRun(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
      );
      await cancelGitHubWorkflowRun(accessToken.token, input, options);
    },
  };
}
