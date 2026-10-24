import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  deepAutoReceiptMarker,
  getGitHubIssueCommentReceiptTarget,
  normalizeGitHubIssueComment,
  verifyGitHubWebhookSignature,
} from './index';

const payload = {
  action: 'created',
  repository: { id: 42 },
  issue: { number: 7, pull_request: {} },
  comment: { id: 99, body: '@deepauto fix the failing test', user: { id: 8 } },
};

test('accepts only a matching GitHub HMAC signature', () => {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', 'secret')
    .update(rawBody)
    .digest('hex')}`;

  expect(verifyGitHubWebhookSignature(rawBody, signature, 'secret')).toBe(true);
  expect(verifyGitHubWebhookSignature(rawBody, signature, 'wrong')).toBe(false);
  expect(verifyGitHubWebhookSignature(rawBody, null, 'secret')).toBe(false);
});

test('normalizes explicit issue or pull-request commands only', () => {
  expect(
    normalizeGitHubIssueComment(payload, {
      workspaceId: 'workspace-1',
      deliveryId: 'delivery-1',
      receivedAt: '2026-10-20T00:00:00.000Z',
      botMention: '@deepauto',
    }),
  ).toMatchObject({
    source: 'github',
    anchor: 'pull-request',
    conversationKey: 'github:42:7',
    instruction: 'fix the failing test',
  });
  expect(
    normalizeGitHubIssueComment(
      { ...payload, comment: { ...payload.comment, body: 'ordinary comment' } },
      {
        workspaceId: 'workspace-1',
        deliveryId: 'delivery-1',
        receivedAt: '2026-10-20T00:00:00.000Z',
        botMention: '@deepauto',
      },
    ),
  ).toBeNull();
  expect(
    normalizeGitHubIssueComment(
      {
        ...payload,
        comment: {
          ...payload.comment,
          body: `@deepauto fix the failing test\n${deepAutoReceiptMarker}`,
        },
      },
      {
        workspaceId: 'workspace-1',
        deliveryId: 'delivery-1',
        receivedAt: '2026-10-20T00:00:00.000Z',
        botMention: '@deepauto',
      },
    ),
  ).toBeNull();
});

test('returns a receipt target only for a signed issue comment repository name', () => {
  expect(
    getGitHubIssueCommentReceiptTarget({
      ...payload,
      repository: { ...payload.repository, full_name: 'owner/repository' },
    }),
  ).toEqual({ repository: 'owner/repository', issueNumber: 7 });
  expect(getGitHubIssueCommentReceiptTarget(payload)).toBeNull();
});
