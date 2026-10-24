import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createGatewayApp } from './app';

const rawBody = JSON.stringify({ action: 'created' });
const signature = `sha256=${createHmac('sha256', 'secret')
  .update(rawBody)
  .digest('hex')}`;

test('rejects GitHub webhooks before parsing when the signature is invalid', async () => {
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
  });
  const response = await app.request('/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=invalid',
    },
    body: rawBody,
  });

  expect(response.status).toBe(401);
});

test('ignores non-issue-comment events after a valid signature', async () => {
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
  });
  const response = await app.request('/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-event': 'ping',
    },
    body: rawBody,
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'ignored' });
});

test('ignores signed comments authored by the configured GitHub bot', async () => {
  const payload = {
    action: 'created',
    repository: { id: 42 },
    issue: { number: 7 },
    comment: {
      id: 99,
      body: '@deepauto fix the failing test',
      user: { id: 1234 },
    },
  };
  const body = JSON.stringify(payload);
  const botSignature = `sha256=${createHmac('sha256', 'secret')
    .update(body)
    .digest('hex')}`;
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
    githubBotUserId: '1234',
  });

  const response = await app.request('/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': botSignature,
    },
    body,
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'ignored' });
});

test('returns execution context only after a trusted GitHub Actions OIDC check', async () => {
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
    githubActions: {
      oidcTrustPolicy: {
        audience: 'deepauto-actions',
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        workflowRef:
          'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
        ref: 'refs/heads/main',
        eventName: 'workflow_dispatch',
      },
      verifyOidcToken: async () => ({
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        workflow_ref:
          'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
        ref: 'refs/heads/main',
        event_name: 'workflow_dispatch',
        run_id: '123',
      }),
    },
    executionService: {
      getActiveExecutionBootstrap: async (_prisma, executionId) => ({
        executionId,
        attemptId: 'attempt-1',
        instruction: 'change before to after',
      }),
      acceptExecutionCallbackByExecutionId: async () => ({ accepted: true }),
    },
  });

  const rejected = await app.request(
    '/github/actions/executions/execution-1/bootstrap',
    { method: 'POST' },
  );
  const accepted = await app.request(
    '/github/actions/executions/execution-1/bootstrap',
    {
      method: 'POST',
      headers: { authorization: 'Bearer oidc-token' },
    },
  );

  expect(rejected.status).toBe(401);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({
    executionId: 'execution-1',
    attemptId: 'attempt-1',
    instruction: 'change before to after',
  });
});

test('issues a short-lived Codex proxy token without exposing the upstream credential', async () => {
  const upstreamRequests: RequestInit[] = [];
  let executionIsActive = true;
  const now = new Date('2026-10-21T00:00:00.000Z');
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
    now: () => now,
    githubActions: {
      oidcTrustPolicy: {
        audience: 'deepauto-actions',
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        workflowRef:
          'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
        ref: 'refs/heads/main',
        eventName: 'workflow_dispatch',
      },
      verifyOidcToken: async () => ({
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        workflow_ref:
          'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
        ref: 'refs/heads/main',
        event_name: 'workflow_dispatch',
        run_id: '123',
      }),
    },
    codexProxy: {
      publicBaseUrl: 'https://gateway.example.test/codex/proxy/v1',
      upstreamResponsesUrl: 'https://api.example.test/v1/responses',
      upstreamApiKey: 'upstream-api-key',
      model: 'gpt-5-codex',
      sessionTokenSecret:
        'a-long-test-secret-that-is-at-least-thirty-two-characters',
      fetch: async (_input, init) => {
        upstreamRequests.push(init ?? {});
        return new Response(JSON.stringify({ id: 'response-1' }), {
          status: 200,
        });
      },
    },
    executionService: {
      getActiveExecutionBootstrap: async (_prisma, executionId) =>
        executionIsActive
          ? {
              executionId,
              attemptId: 'attempt-1',
              instruction: 'change before to after',
            }
          : null,
      acceptExecutionCallbackByExecutionId: async () => ({ accepted: true }),
    },
  });

  const sessionResponse = await app.request(
    '/github/actions/executions/execution-1/codex/session',
    {
      method: 'POST',
      headers: { authorization: 'Bearer oidc-token' },
    },
  );
  const session = (await sessionResponse.json()) as Record<string, unknown>;

  expect(sessionResponse.status).toBe(200);
  expect(session).toMatchObject({
    baseUrl: 'https://gateway.example.test/codex/proxy/v1',
    expiresAt: '2026-10-21T00:05:00.000Z',
  });
  expect(session).not.toHaveProperty('instruction');
  expect(session).not.toHaveProperty('upstreamApiKey');
  expect(session.accessToken).toEqual(expect.any(String));

  const proxyResponse = await app.request('/codex/proxy/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'untrusted-model', input: 'do work' }),
  });

  expect(proxyResponse.status).toBe(200);
  expect(await proxyResponse.json()).toEqual({ id: 'response-1' });
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0]?.headers).toEqual({
    authorization: 'Bearer upstream-api-key',
    'content-type': 'application/json',
  });
  expect(JSON.parse(String(upstreamRequests[0]?.body))).toEqual({
    model: 'gpt-5-codex',
    input: 'do work',
  });

  executionIsActive = false;
  const unavailableResponse = await app.request('/codex/proxy/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: 'do work' }),
  });
  expect(unavailableResponse.status).toBe(403);
  expect(upstreamRequests).toHaveLength(1);
});

test('accepts a terminal callback without exposing the callback claim', async () => {
  let callbackInput: Record<string, unknown> | undefined;
  let releasedExecutionId: string | undefined;
  const app = createGatewayApp({
    prisma: {} as never,
    githubWebhookSecret: 'secret',
    githubWorkspaceId: 'workspace-1',
    githubBotMention: '@deepauto',
    githubActions: {
      oidcTrustPolicy: {
        audience: 'deepauto-actions',
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        workflowRef:
          'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
        ref: 'refs/heads/main',
        eventName: 'workflow_dispatch',
      },
      verifyOidcToken: async () => ({
        repository: 'liaowenjie15/deepauto-harness-sandbox',
        workflow_ref:
          'liaowenjie15/deepauto-harness-sandbox/.github/workflows/deepauto-execute.yml@refs/heads/main',
        ref: 'refs/heads/main',
        event_name: 'workflow_dispatch',
        run_id: '123',
      }),
    },
    onExecutionCallbackAccepted: async (executionId) => {
      releasedExecutionId = executionId;
    },
    executionService: {
      getActiveExecutionBootstrap: async () => null,
      acceptExecutionCallbackByExecutionId: async (_prisma, input) => {
        callbackInput = input;
        return { accepted: true };
      },
    },
  });

  const response = await app.request(
    '/github/actions/executions/execution-1/callback',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer oidc-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        attemptId: 'attempt-1',
        result: {
          status: 'COMPLETED',
          safeSummary: 'Execution completed successfully.',
          retryable: false,
          artifacts: [],
          finishedAt: '2026-10-25T00:00:00.000Z',
        },
        events: [
          { type: 'started', attemptId: 'attempt-1' },
          { type: 'completed', attemptId: 'attempt-1' },
        ],
      }),
    },
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'accepted' });
  expect(callbackInput).toMatchObject({
    executionId: 'execution-1',
    attemptId: 'attempt-1',
    result: { status: 'COMPLETED' },
  });
  expect(callbackInput).not.toHaveProperty('callbackClaimId');
  expect(releasedExecutionId).toBe('execution-1');
});
