import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type InboundInvocation,
  inboundInvocationSchema,
} from '@deepauto/contracts';
import { z } from 'zod';

export {
  createGitHubAppJwt,
  createGitHubAppWorkflowDispatcher,
  createGitHubInstallationAccessToken,
  dispatchGitHubWorkflow,
  type GitHubAppClientOptions,
  type GitHubAppCredentials,
  type GitHubFetch,
  type GitHubInstallationAccessToken,
  type GitHubWorkflowDispatch,
  type GitHubWorkflowDispatcher,
} from './actions';
export {
  assertGitHubActionsOidcClaims,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifier,
  type GitHubActionsOidcTrustPolicy,
  verifyGitHubActionsOidcToken,
} from './actions-oidc';

const issueCommentSchema = z.object({
  action: z.literal('created'),
  repository: z.object({ id: z.union([z.string(), z.number()]) }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.union([z.string(), z.number()]),
    body: z.string(),
    user: z.object({ id: z.union([z.string(), z.number()]) }),
  }),
});

export function verifyGitHubWebhookSignature(
  rawBody: string,
  signature: string | null,
  webhookSecret: string,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex')}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function normalizeGitHubIssueComment(
  payload: unknown,
  input: {
    workspaceId: string;
    deliveryId: string;
    receivedAt: string;
    botMention: string;
  },
): InboundInvocation | null {
  const parsed = issueCommentSchema.safeParse(payload);
  if (!parsed.success) return null;

  const mention = input.botMention.trim();
  const instruction = parsed.data.comment.body.replace(mention, '').trim();
  if (!mention || !parsed.data.comment.body.includes(mention) || !instruction) {
    return null;
  }

  const repositoryId = String(parsed.data.repository.id);
  const issueNumber = parsed.data.issue.number;
  const anchor = parsed.data.issue.pull_request ? 'pull-request' : 'issue';

  return inboundInvocationSchema.parse({
    source: 'github',
    workspaceId: input.workspaceId,
    actorId: String(parsed.data.comment.user.id),
    providerActorId: String(parsed.data.comment.user.id),
    repositoryId,
    conversationKey: `github:${repositoryId}:${issueNumber}`,
    anchor,
    instruction,
    sourceEventId: input.deliveryId,
    idempotencyKey: `github:comment:${parsed.data.comment.id}`,
    receivedAt: input.receivedAt,
  });
}
