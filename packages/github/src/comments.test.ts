import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  createGitHubAppIssueCommentPublisher,
  type GitHubFetch,
} from './comments';

test('publishes a repository-scoped receipt with only issues write permission', async () => {
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
    return new Response(null, { status: 201 });
  };
  const publisher = createGitHubAppIssueCommentPublisher(
    {
      appId: '5398938',
      installationId: '173461210',
      privateKey: privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    },
    { fetch: request, now: () => new Date('2026-10-21T00:00:00.000Z') },
  );

  await publisher.publish({
    repository: 'liaowenjie15/deepauto-harness-sandbox',
    issueNumber: 7,
    body: 'The DeepAuto task is queued.\n\n<!-- deepauto-receipt -->',
  });

  expect(requests).toHaveLength(2);
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    repositories: ['deepauto-harness-sandbox'],
    permissions: { issues: 'write' },
  });
  expect(requests[1]).toMatchObject({
    url: 'https://api.github.com/repos/liaowenjie15/deepauto-harness-sandbox/issues/7/comments',
    init: {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer installation-token',
      }),
    },
  });
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    body: 'The DeepAuto task is queued.\n\n<!-- deepauto-receipt -->',
  });
});
