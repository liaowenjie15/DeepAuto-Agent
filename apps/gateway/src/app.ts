import { executionEventSchema } from '@deepauto/contracts';
import {
  acceptExecutionCallbackByExecutionId,
  type ExecutionBootstrap,
  type ExecutionCallbackByExecutionIdInput,
  getActiveExecutionBootstrap,
  type PrismaClient,
} from '@deepauto/db';
import {
  type GitHubActionsOidcTokenVerifier,
  type GitHubActionsOidcTrustPolicy,
  normalizeGitHubIssueComment,
  verifyGitHubActionsOidcToken,
  verifyGitHubWebhookSignature,
} from '@deepauto/github';
import { Hono } from 'hono';
import { z } from 'zod';
import { dispatchInboundInvocation } from './dispatcher';

const executionCallbackSchema = z.object({
  status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  reason: z.string().trim().min(1).optional(),
  events: z.array(executionEventSchema),
});

export type GitHubActionsGatewayConfiguration = {
  oidcTrustPolicy: GitHubActionsOidcTrustPolicy;
  verifyOidcToken?: GitHubActionsOidcTokenVerifier;
};

export type GatewayExecutionService = {
  getActiveExecutionBootstrap: (
    prisma: PrismaClient,
    executionId: string,
    now?: Date,
  ) => Promise<ExecutionBootstrap | null>;
  acceptExecutionCallbackByExecutionId: (
    prisma: PrismaClient,
    input: ExecutionCallbackByExecutionIdInput,
  ) => Promise<{ accepted: boolean }>;
};

export type GatewayConfiguration = {
  prisma: PrismaClient;
  githubWebhookSecret: string;
  githubWorkspaceId: string;
  githubBotMention: string;
  githubActions?: GitHubActionsGatewayConfiguration;
  executionService?: GatewayExecutionService;
  now?: () => Date;
};

function bearerToken(value: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
  return match?.[1]?.trim() || null;
}

async function verifyActionsRequest(
  authorization: string | undefined,
  configuration: GitHubActionsGatewayConfiguration,
): Promise<boolean> {
  const token = bearerToken(authorization);
  if (!token) return false;

  try {
    await verifyGitHubActionsOidcToken(
      token,
      configuration.oidcTrustPolicy,
      configuration.verifyOidcToken,
    );
    return true;
  } catch {
    return false;
  }
}

export function createGatewayApp(configuration: GatewayConfiguration) {
  const app = new Hono();
  const executionService =
    configuration.executionService ??
    ({
      getActiveExecutionBootstrap,
      acceptExecutionCallbackByExecutionId,
    } satisfies GatewayExecutionService);

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

  app.post(
    '/github/actions/executions/:executionId/bootstrap',
    async (context) => {
      if (!configuration.githubActions) {
        return context.json(
          { error: 'GitHub Actions execution is not configured' },
          404,
        );
      }
      if (
        !(await verifyActionsRequest(
          context.req.header('authorization'),
          configuration.githubActions,
        ))
      ) {
        return context.json(
          { error: 'invalid GitHub Actions OIDC token' },
          401,
        );
      }

      const bootstrap = await executionService.getActiveExecutionBootstrap(
        configuration.prisma,
        context.req.param('executionId'),
        configuration.now?.(),
      );
      if (!bootstrap)
        return context.json({ error: 'execution is unavailable' }, 404);

      return context.json(bootstrap);
    },
  );

  app.post(
    '/github/actions/executions/:executionId/callback',
    async (context) => {
      if (!configuration.githubActions) {
        return context.json(
          { error: 'GitHub Actions execution is not configured' },
          404,
        );
      }
      if (
        !(await verifyActionsRequest(
          context.req.header('authorization'),
          configuration.githubActions,
        ))
      ) {
        return context.json(
          { error: 'invalid GitHub Actions OIDC token' },
          401,
        );
      }

      const body = executionCallbackSchema.safeParse(await context.req.json());
      if (!body.success)
        return context.json({ error: 'invalid callback payload' }, 400);

      const result =
        await executionService.acceptExecutionCallbackByExecutionId(
          configuration.prisma,
          {
            executionId: context.req.param('executionId'),
            ...body.data,
            now: configuration.now?.(),
          },
        );
      return context.json(
        { status: result.accepted ? 'accepted' : 'rejected' },
        result.accepted ? 202 : 409,
      );
    },
  );

  return app;
}
