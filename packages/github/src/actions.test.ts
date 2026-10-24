import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  cancelGitHubWorkflowRun,
  createGitHubInstallationAccessToken,
  dispatchGitHubWorkflow,
  type GitHubFetch,
  getGitHubWorkflowRun,
  isRetryableGitHubRequestError,
} from './actions';

test('limits an installation token request to the sandbox repository', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: GitHubFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({
      token: 'installation-token',
      expires_at: '2026-10-21T01:00:00.000Z',
    });
  };

  await expect(
    createGitHubInstallationAccessToken(
      {
        appId: '5398938',
        installationId: '173461210',
        privateKey: privateKey
          .export({ format: 'pem', type: 'pkcs8' })
          .toString(),
      },
      'liaowenjie15/deepauto-harness-sandbox',
      { fetch: request, now: () => new Date('2026-10-21T00:00:00.000Z') },
    ),
  ).resolves.toEqual({
    token: 'installation-token',
    expiresAt: new Date('2026-10-21T01:00:00.000Z'),
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: 'https://api.github.com/app/installations/173461210/access_tokens',
    init: {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: expect.stringMatching(/^Bearer /),
      }),
    },
  });
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    repositories: ['deepauto-harness-sandbox'],
    permissions: {
      actions: 'write',
      contents: 'write',
      pull_requests: 'write',
    },
  });
});

test('dispatches an explicit workflow ref and only declared inputs', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: GitHubFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };

  await dispatchGitHubWorkflow(
    'installation-token',
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      workflow: 'deepauto-execute.yml',
      ref: 'main',
      inputs: { execution_id: 'execution-1' },
    },
    { fetch: request },
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: 'https://api.github.com/repos/liaowenjie15/deepauto-harness-sandbox/actions/workflows/deepauto-execute.yml/dispatches',
    init: {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer installation-token',
      }),
    },
  });
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    ref: 'main',
    inputs: { execution_id: 'execution-1' },
  });
});

test('cancels a supplied workflow run ID', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: GitHubFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 202 });
  };

  await cancelGitHubWorkflowRun(
    'installation-token',
    {
      repository: 'liaowenjie15/deepauto-harness-sandbox',
      runId: 43,
    },
    { fetch: request },
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: 'https://api.github.com/repos/liaowenjie15/deepauto-harness-sandbox/actions/runs/43/cancel',
    init: {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer installation-token',
      }),
    },
  });
});

test('gets one workflow run by its persisted ID', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: GitHubFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({
      id: 43,
      status: 'in_progress',
      conclusion: null,
      display_title: 'DeepAuto execution execution-1',
      html_url: 'https://github.com/example/repository/actions/runs/43',
    });
  };

  await expect(
    getGitHubWorkflowRun(
      'installation-token',
      {
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        runId: 43,
      },
      { fetch: request },
    ),
  ).resolves.toEqual({
    id: 43,
    status: 'in_progress',
    conclusion: null,
    url: 'https://github.com/example/repository/actions/runs/43',
  });
  expect(requests[0]?.url).toBe(
    'https://api.github.com/repos/liaowenjie15/deepauto-harness-sandbox/actions/runs/43',
  );
});

test('rejects malformed repository names before an API request', async () => {
  const request: GitHubFetch = async () => {
    throw new Error('request should not be called');
  };

  await expect(
    dispatchGitHubWorkflow(
      'installation-token',
      {
        repository: 'not a repository',
        workflow: 'deepauto-execute.yml',
        ref: 'main',
      },
      { fetch: request },
    ),
  ).rejects.toThrow('Repository must be owner/repository');
});

test('classifies only transient GitHub API failures as retryable', async () => {
  const failure = async (status: number) => {
    try {
      await dispatchGitHubWorkflow(
        'installation-token',
        {
          repository: 'liaowenjie15/deepauto-harness-sandbox',
          workflow: 'deepauto-execute.yml',
          ref: 'main',
        },
        {
          fetch: async () => new Response(null, { status }),
        },
      );
    } catch (error) {
      return error;
    }
    throw new Error('Expected workflow dispatch to fail');
  };

  expect(isRetryableGitHubRequestError(await failure(503))).toBe(true);
  expect(isRetryableGitHubRequestError(await failure(429))).toBe(true);
  expect(isRetryableGitHubRequestError(await failure(403))).toBe(false);
});
