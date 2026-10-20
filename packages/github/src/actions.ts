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

export type GitHubAppCredentials = z.infer<typeof appCredentialsSchema>;
export type GitHubWorkflowDispatch = z.input<typeof workflowDispatchSchema>;

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

function apiUrl(options: GitHubAppClientOptions): string {
  return (options.apiUrl ?? githubApiUrl).replace(/\/$/, '');
}

function failGitHubRequest(response: Response, operation: string): Error {
  return new Error(
    `GitHub ${operation} failed with HTTP ${response.status} ${response.statusText}`,
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

export function createGitHubAppWorkflowDispatcher(
  credentials: GitHubAppCredentials,
  options: GitHubAppClientOptions = {},
): GitHubWorkflowDispatcher {
  return {
    async dispatch(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
      );
      await dispatchGitHubWorkflow(accessToken.token, input, options);
    },
  };
}
