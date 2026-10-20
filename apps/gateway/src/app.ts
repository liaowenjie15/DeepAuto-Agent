import type { PrismaClient } from '@deepauto/db';
import {
  normalizeGitHubIssueComment,
  verifyGitHubWebhookSignature,
} from '@deepauto/github';
import { Hono } from 'hono';
import { dispatchInboundInvocation } from './dispatcher';

export type GatewayConfiguration = {
  prisma: PrismaClient;
  githubWebhookSecret: string;
  githubWorkspaceId: string;
  githubBotMention: string;
};

export function createGatewayApp(configuration: GatewayConfiguration) {
  const app = new Hono();

  app.post('/github/webhooks', async (context) => {
    const rawBody = await context.req.text();
    if (
      !verifyGitHubWebhookSignature(
        rawBody,
        context.req.header('x-hub-signature-256') ?? null,
        configuration.githubWebhookSecret,
      )
    ) {
      return context.json({ error: 'invalid signature' }, 401);
    }

    if (context.req.header('x-github-event') !== 'issue_comment') {
      return context.json({ status: 'ignored' }, 202);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return context.json({ error: 'invalid JSON' }, 400);
    }

    const deliveryId = context.req.header('x-github-delivery');
    if (!deliveryId) return context.json({ error: 'missing delivery ID' }, 400);

    const result = await dispatchInboundInvocation(
      configuration.prisma,
      normalizeGitHubIssueComment(payload, {
        workspaceId: configuration.githubWorkspaceId,
        deliveryId,
        receivedAt: new Date().toISOString(),
        botMention: configuration.githubBotMention,
      }),
    );
    return context.json(result, result.status === 'unauthorized' ? 403 : 202);
  });

  return app;
}
