import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { GitHubFetch } from './actions';
import { createGitHubAppPullRequestInspector } from './pull-requests';

test('treats a pull request with an unavailable head repository as a fork', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: GitHubFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      return Response.json({
        token: 'installation-token',
        expires_at: '2026-10-21T01:00:00.000Z',
      });
    }
    return Response.json({ head: { repo: null } });
  };
  const inspector = createGitHubAppPullRequestInspector(
    {
      appId: '5398938',
      installationId: '173461210',
      privateKey: privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    },
    { fetch: request, now: () => new Date('2026-10-21T00:00:00.000Z') },
  );

  await expect(
    inspector.inspect({
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      pullRequestNumber: 7,
    }),
  ).resolves.toEqual({ isFork: true });

  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    repositories: ['deepauto-harness-sandbox'],
    permissions: { pull_requests: 'read' },
  });
  expect(requests[1]).toMatchObject({
    url: 'https://api.github.com/repos/liaowenjie15/deepauto-harness-sandbox/pulls/7',
    init: {
      headers: expect.objectContaining({
        Authorization: 'Bearer installation-token',
      }),
    },
  });
});
