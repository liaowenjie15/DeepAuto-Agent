import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type InboundInvocation,
  inboundInvocationSchema,
} from '@deepauto/contracts';
import { z } from 'zod';

export {
  cancelGitHubWorkflowRun,
  createGitHubAppJwt,
  createGitHubAppWorkflowController,
  createGitHubAppWorkflowDispatcher,
  createGitHubInstallationAccessToken,
  dispatchGitHubWorkflow,
  type GitHubAppClientOptions,
  type GitHubAppCredentials,
  type GitHubAppInstallationPermissions,
  type GitHubFetch,
  type GitHubInstallationAccessToken,
  GitHubRequestError,
  type GitHubWorkflowController,
  type GitHubWorkflowDispatch,
  type GitHubWorkflowDispatcher,
  type GitHubWorkflowRun,
  type GitHubWorkflowRunCancellation,
  getGitHubWorkflowRun,
  isRetryableGitHubRequestError,
} from './actions';
export {
  assertGitHubActionsOidcClaims,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifier,
  type GitHubActionsOidcTrustPolicy,
  verifyGitHubActionsOidcToken,
} from './actions-oidc';
export {
  createGitHubAppIssueCommentPublisher,
  createGitHubIssueComment,
  type GitHubIssueComment,
  type GitHubIssueCommentPublisher,
} from './comments';
export {
  type ExecutionProxyTokenClaims,
  issueExecutionProxyToken,
  verifyExecutionProxyToken,
} from './execution-proxy-token';
export {
  createGitHubAppPullRequestInspector,
  type GitHubPullRequest,
  type GitHubPullRequestInspector,
  type GitHubPullRequestLookup,
  getGitHubPullRequest,
} from './pull-requests';

const issueCommentSchema = z.object({
  action: z.literal('created'),
  repository: z.object({
    id: z.union([z.string(), z.number()]),
    full_name: z.string().trim().min(1).optional(),
  }),
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

export const deepAutoReceiptMarker = '<!-- deepauto-receipt -->';

export function isGitHubIssueCommentFromActor(
  payload: unknown,
  actorId: string,
): boolean {
  const parsed = issueCommentSchema.safeParse(payload);
  return parsed.success && String(parsed.data.comment.user.id) === actorId;
}

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
  if (parsed.data.comment.body.includes(deepAutoReceiptMarker)) return null;

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

export type GitHubIssueCommentReceiptTarget = {
  repository: string;
  issueNumber: number;
};

export function getGitHubIssueCommentReceiptTarget(
  payload: unknown,
): GitHubIssueCommentReceiptTarget | null {
  const parsed = issueCommentSchema.safeParse(payload);
  if (!parsed.success) return null;

  const repository = parsed.data.repository.full_name?.trim();
  if (!repository) return null;

  return { repository, issueNumber: parsed.data.issue.number };
}
