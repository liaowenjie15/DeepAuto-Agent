import { z } from 'zod';
import {
  createGitHubInstallationAccessToken,
  type GitHubAppClientOptions,
  type GitHubAppCredentials,
  type GitHubFetch,
  GitHubRequestError,
} from './actions';

const githubApiUrl = 'https://api.github.com';

const pullRequestLookupSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'Repository must be owner/repository'),
  pullRequestNumber: z.number().int().positive(),
});

const pullRequestResponseSchema = z.object({
  head: z.object({
    repo: z.object({ fork: z.boolean() }).nullable(),
  }),
});

export type GitHubPullRequestLookup = z.input<typeof pullRequestLookupSchema>;

export type GitHubPullRequest = {
  isFork: boolean;
};

export type GitHubPullRequestInspector = {
  inspect(input: GitHubPullRequestLookup): Promise<GitHubPullRequest>;
};

function apiUrl(options: GitHubAppClientOptions): string {
  return (options.apiUrl ?? githubApiUrl).replace(/\/$/, '');
}

export async function getGitHubPullRequest(
  accessToken: string,
  input: GitHubPullRequestLookup,
  options: Omit<GitHubAppClientOptions, 'now'> = {},
): Promise<GitHubPullRequest> {
  const parsedToken = z.string().trim().min(1).parse(accessToken);
  const parsedInput = pullRequestLookupSchema.parse(input);
  const request: GitHubFetch = options.fetch ?? fetch;
  const response = await request(
    `${apiUrl(options)}/repos/${parsedInput.repository}/pulls/${parsedInput.pullRequestNumber}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${parsedToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      'pull request lookup',
      response.status,
      response.statusText,
    );
  }

  const pullRequest = pullRequestResponseSchema.parse(await response.json());
  return { isFork: pullRequest.head.repo?.fork ?? true };
}

export function createGitHubAppPullRequestInspector(
  credentials: GitHubAppCredentials,
  options: GitHubAppClientOptions = {},
): GitHubPullRequestInspector {
  return {
    async inspect(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
        { pull_requests: 'read' },
      );
      return getGitHubPullRequest(accessToken.token, input, options);
    },
  };
}
