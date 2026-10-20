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

test('accepts a terminal callback without exposing the callback claim', async () => {
  let callbackInput: Record<string, unknown> | undefined;
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
        status: 'COMPLETED',
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
    status: 'COMPLETED',
  });
  expect(callbackInput).not.toHaveProperty('callbackClaimId');
});
