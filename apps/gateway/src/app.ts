import {
  executionEventSchema,
  executionResultSchema,
} from '@deepauto/contracts';
import {
  acceptExecutionCallbackByExecutionId,
  bindExecutionToExternalRun,
  consumeExecutionBootstrapCapability,
  type ExecutionBootstrap,
  type ExecutionCallbackByExecutionIdInput,
  getActiveExecutionBootstrap,
  type PrismaClient,
} from '@deepauto/db';
import {
  deepAutoReceiptMarker,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifier,
  type GitHubActionsOidcTrustPolicy,
  type GitHubIssueCommentPublisher,
  type GitHubPullRequestInspector,
  getGitHubIssueCommentReceiptTarget,
  isGitHubIssueCommentFromActor,
  issueExecutionProxyToken,
  normalizeGitHubIssueComment,
  verifyExecutionProxyToken,
  verifyGitHubActionsOidcToken,
  verifyGitHubWebhookSignature,
} from '@deepauto/github';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  dispatchExecutionControl,
  dispatchInboundInvocation,
  type PilotAdmissionProvider,
} from './dispatcher';
import {
  executionControlReceipt,
  hasGitHubExecutionControlPrefix,
  parseGitHubExecutionControlCommand,
} from './execution-control-command';

const executionCallbackSchema = z.object({
  attemptId: z.string().trim().min(1),
  result: executionResultSchema,
  events: z.array(executionEventSchema),
});

const executionBootstrapSchema = z.object({
  capability: z.string().trim().min(43).max(128),
});

const codexProxyConfigurationSchema = z.object({
  publicBaseUrl: z.url().refine((value) => value.startsWith('https://'), {
    message: 'Codex proxy public URL must use HTTPS',
  }),
  upstreamResponsesUrl: z
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'Codex upstream URL must use HTTPS',
    }),
  upstreamApiKey: z.string().trim().min(1),
  model: z.string().trim().min(1),
  sessionTokenSecret: z.string().min(32),
  sessionTtlMilliseconds: z
    .number()
    .int()
    .positive()
    .max(15 * 60 * 1000)
    .optional(),
});

const maximumCodexRequestBytes = 1024 * 1024;
const defaultCodexSessionTtlMilliseconds = 5 * 60 * 1000;

type CodexProxyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type CodexProxyConfiguration = z.input<typeof codexProxyConfigurationSchema> & {
  fetch?: CodexProxyFetch;
};

export type GitHubActionsGatewayConfiguration = {
  oidcTrustPolicy: GitHubActionsOidcTrustPolicy;
  verifyOidcToken?: GitHubActionsOidcTokenVerifier;
};

export type GatewayExecutionService = {
  consumeExecutionBootstrapCapability: (
    prisma: PrismaClient,
    executionId: string,
    capability: string,
    externalRunId: bigint,
    externalRunAttempt: number,
    now?: Date,
  ) => Promise<boolean>;
  bindExecutionToExternalRun: (
    prisma: PrismaClient,
    executionId: string,
    externalRunId: bigint,
    externalRunAttempt: number,
  ) => Promise<boolean>;
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

export type GitHubCommentReceiptPublisher = GitHubIssueCommentPublisher;

export type GatewayConfiguration = {
  prisma: PrismaClient;
  githubWebhookSecret: string;
  githubWorkspaceId: string;
  githubBotMention: string;
  githubBotUserId?: string;
  githubPullRequestInspector?: GitHubPullRequestInspector;
  githubActions?: GitHubActionsGatewayConfiguration;
  githubCommentReceiptPublisher?: GitHubCommentReceiptPublisher;
  codexProxy?: CodexProxyConfiguration;
  pilotAdmission?: PilotAdmissionProvider;
  onExecutionCallbackAccepted?: (executionId: string) => Promise<void>;
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
): Promise<GitHubActionsOidcClaims | null> {
  const token = bearerToken(authorization);
  if (!token) return null;

  try {
    return await verifyGitHubActionsOidcToken(
      token,
      configuration.oidcTrustPolicy,
      configuration.verifyOidcToken,
    );
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configuredCodexProxy(configuration: CodexProxyConfiguration) {
  return codexProxyConfigurationSchema.parse(configuration);
}

export function createGatewayApp(configuration: GatewayConfiguration) {
  const app = new Hono();
  const executionService =
    configuration.executionService ??
    ({
      getActiveExecutionBootstrap,
      bindExecutionToExternalRun,
      consumeExecutionBootstrapCapability,
      acceptExecutionCallbackByExecutionId,
    } satisfies GatewayExecutionService);
  const codexProxy = configuration.codexProxy
    ? configuredCodexProxy(configuration.codexProxy)
    : undefined;

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
    if (
      configuration.githubBotUserId &&
      isGitHubIssueCommentFromActor(payload, configuration.githubBotUserId)
    ) {
      return context.json({ status: 'ignored' }, 202);
    }

    const invocation = normalizeGitHubIssueComment(payload, {
      workspaceId: configuration.githubWorkspaceId,
      deliveryId,
      receivedAt: new Date().toISOString(),
      botMention: configuration.githubBotMention,
    });
    const command = invocation
      ? parseGitHubExecutionControlCommand(invocation.instruction)
      : null;
    if (
      invocation &&
      !command &&
      hasGitHubExecutionControlPrefix(invocation.instruction)
    ) {
      return context.json({ status: 'ignored' }, 202);
    }
    if (command) {
      const result = await dispatchExecutionControl(
        configuration.prisma,
        invocation,
        command,
      );
      if (result.status !== 'controlled') {
        return context.json(
          result,
          result.status === 'unauthorized' ? 403 : 202,
        );
      }

      const receipt = executionControlReceipt(result.result);
      const target = getGitHubIssueCommentReceiptTarget(payload);
      if (target && configuration.githubCommentReceiptPublisher) {
        await configuration.githubCommentReceiptPublisher.publish({
          ...target,
          body: `${receipt}\n\n${deepAutoReceiptMarker}`,
        });
      }
      return context.json({ status: 'controlled', receipt }, 202);
    }

    const pullRequestAdmission =
      invocation?.anchor === 'pull-request'
        ? async () => {
            const target = getGitHubIssueCommentReceiptTarget(payload);
            if (!target || !configuration.githubPullRequestInspector) {
              return {
                accepted: false as const,
                reason: 'pull_request_inspection_unavailable',
              };
            }
            try {
              const pullRequest =
                await configuration.githubPullRequestInspector.inspect({
                  repository: target.repository,
                  pullRequestNumber: target.issueNumber,
                });
              return pullRequest.isFork
                ? {
                    accepted: false as const,
                    reason: 'fork_pull_request',
                    isFork: true,
                  }
                : { accepted: true as const };
            } catch {
              return {
                accepted: false as const,
                reason: 'pull_request_inspection_failed',
              };
            }
          }
        : undefined;
    const result = await dispatchInboundInvocation(
      configuration.prisma,
      invocation,
      configuration.pilotAdmission,
      pullRequestAdmission,
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
      const claims = await verifyActionsRequest(
        context.req.header('authorization'),
        configuration.githubActions,
      );
      if (!claims) {
        return context.json(
          { error: 'invalid GitHub Actions OIDC token' },
          401,
        );
      }
      const body = executionBootstrapSchema.safeParse(await context.req.json());
      if (!body.success)
        return context.json({ error: 'invalid bootstrap payload' }, 400);
      if (
        !(await executionService.consumeExecutionBootstrapCapability(
          configuration.prisma,
          context.req.param('executionId'),
          body.data.capability,
          BigInt(claims.run_id),
          claims.run_attempt,
          configuration.now?.(),
        ))
      ) {
        return context.json({ error: 'execution is unavailable' }, 404);
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
    '/github/actions/executions/:executionId/codex/session',
    async (context) => {
      if (!configuration.githubActions || !codexProxy) {
        return context.json({ error: 'Codex proxy is not configured' }, 404);
      }
      const claims = await verifyActionsRequest(
        context.req.header('authorization'),
        configuration.githubActions,
      );
      if (!claims) {
        return context.json(
          { error: 'invalid GitHub Actions OIDC token' },
          401,
        );
      }

      const now = configuration.now?.() ?? new Date();
      const executionId = context.req.param('executionId');
      if (
        !(await executionService.bindExecutionToExternalRun(
          configuration.prisma,
          executionId,
          BigInt(claims.run_id),
          claims.run_attempt,
        ))
      )
        return context.json({ error: 'execution is unavailable' }, 404);
      const bootstrap = await executionService.getActiveExecutionBootstrap(
        configuration.prisma,
        executionId,
        now,
      );
      if (!bootstrap)
        return context.json({ error: 'execution is unavailable' }, 404);

      const expiresAt = new Date(
        now.getTime() +
          (codexProxy.sessionTtlMilliseconds ??
            defaultCodexSessionTtlMilliseconds),
      );
      const accessToken = await issueExecutionProxyToken({
        executionId,
        expiresAt,
        secret: codexProxy.sessionTokenSecret,
        now,
      });
      return context.json({
        baseUrl: codexProxy.publicBaseUrl,
        accessToken,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  app.post('/codex/proxy/v1/responses', async (context) => {
    if (!codexProxy) {
      return context.json({ error: 'Codex proxy is not configured' }, 404);
    }
    const token = bearerToken(context.req.header('authorization'));
    if (!token) return context.json({ error: 'invalid proxy token' }, 401);

    const now = configuration.now?.() ?? new Date();
    let claims: { execution_id: string };
    try {
      claims = await verifyExecutionProxyToken(
        token,
        codexProxy.sessionTokenSecret,
        now,
      );
    } catch {
      return context.json({ error: 'invalid proxy token' }, 401);
    }

    const bootstrap = await executionService.getActiveExecutionBootstrap(
      configuration.prisma,
      claims.execution_id,
      now,
    );
    if (!bootstrap)
      return context.json({ error: 'execution is unavailable' }, 403);

    const contentLength = Number(context.req.header('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > maximumCodexRequestBytes
    ) {
      return context.json({ error: 'Codex request is too large' }, 413);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'invalid Codex request JSON' }, 400);
    }
    if (!isJsonObject(body)) {
      return context.json({ error: 'invalid Codex request JSON' }, 400);
    }

    try {
      const response = await (configuration.codexProxy?.fetch ?? fetch)(
        codexProxy.upstreamResponsesUrl,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${codexProxy.upstreamApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...body, model: codexProxy.model }),
        },
      );
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      return context.json({ error: 'Codex upstream is unavailable' }, 502);
    }
  });

  app.post(
    '/github/actions/executions/:executionId/callback',
    async (context) => {
      if (!configuration.githubActions) {
        return context.json(
          { error: 'GitHub Actions execution is not configured' },
          404,
        );
      }
      const claims = await verifyActionsRequest(
        context.req.header('authorization'),
        configuration.githubActions,
      );
      if (!claims) {
        return context.json(
          { error: 'invalid GitHub Actions OIDC token' },
          401,
        );
      }

      if (
        !(await executionService.bindExecutionToExternalRun(
          configuration.prisma,
          context.req.param('executionId'),
          BigInt(claims.run_id),
          claims.run_attempt,
        ))
      )
        return context.json({ error: 'execution is unavailable' }, 404);

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
      if (result.accepted) {
        try {
          await configuration.onExecutionCallbackAccepted?.(
            context.req.param('executionId'),
          );
        } catch {}
      }
      return context.json(
        { status: result.accepted ? 'accepted' : 'rejected' },
        result.accepted ? 202 : 409,
      );
    },
  );

  return app;
}
