import { z } from 'zod';
import {
  createGitHubInstallationAccessToken,
  type GitHubAppClientOptions,
  type GitHubAppCredentials,
  type GitHubFetch,
  GitHubRequestError,
} from './actions';

const githubApiUrl = 'https://api.github.com';

const issueCommentSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'Repository must be owner/repository'),
  issueNumber: z.number().int().positive(),
  body: z.string().trim().min(1),
});

export type GitHubIssueComment = z.input<typeof issueCommentSchema>;

export type GitHubIssueCommentPublisher = {
  publish(input: GitHubIssueComment): Promise<void>;
};

function apiUrl(options: GitHubAppClientOptions): string {
  return (options.apiUrl ?? githubApiUrl).replace(/\/$/, '');
}

export async function createGitHubIssueComment(
  accessToken: string,
  input: GitHubIssueComment,
  options: Omit<GitHubAppClientOptions, 'now'> = {},
): Promise<void> {
  const parsedToken = z.string().trim().min(1).parse(accessToken);
  const parsedInput = issueCommentSchema.parse(input);
  const request: GitHubFetch = options.fetch ?? fetch;
  const response = await request(
    `${apiUrl(options)}/repos/${parsedInput.repository}/issues/${parsedInput.issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${parsedToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body: parsedInput.body }),
    },
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      'issue comment request',
      response.status,
      response.statusText,
    );
  }
}

export function createGitHubAppIssueCommentPublisher(
  credentials: GitHubAppCredentials,
  options: GitHubAppClientOptions = {},
): GitHubIssueCommentPublisher {
  return {
    async publish(input) {
      const accessToken = await createGitHubInstallationAccessToken(
        credentials,
        input.repository,
        options,
        { issues: 'write' },
      );
      await createGitHubIssueComment(accessToken.token, input, options);
    },
  };
}
