import { existsSync } from 'node:fs';
import { createPrismaClient, type PrismaClient } from '@deepauto/db';
import {
  createGitHubAppIssueCommentPublisher,
  createGitHubAppPullRequestInspector,
  type GitHubAppCredentials,
} from '@deepauto/github';
import { config as loadEnvironmentFile } from 'dotenv';
import { z } from 'zod';
import { createGatewayApp, type GatewayConfiguration } from './app';

const optionalText = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

const gatewayConfigurationSchema = z.object({
  DATABASE_URL: z.url(),
  GITHUB_WEBHOOK_SECRET: z.string().min(32),
  GITHUB_WORKSPACE_ID: z.string().trim().min(1),
  GITHUB_BOT_MENTION: z.string().trim().min(2),
  GITHUB_BOT_USER_ID: optionalText,
  GITHUB_BOT_LOGIN: optionalText,
  GITHUB_APP_ID: optionalText,
  GITHUB_APP_INSTALLATION_ID: optionalText,
  GITHUB_APP_PRIVATE_KEY: optionalText.transform((value) =>
    value?.replace(/\\n/g, '\n'),
  ),
  DEEPAUTO_GATEWAY_HOST: optionalText.default('127.0.0.1'),
  DEEPAUTO_GATEWAY_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .default(3000),
  DEEPAUTO_PILOT_ENABLED: z.enum(['true', 'false']).default('false'),
  DEEPAUTO_PILOT_MEMBER_ID: optionalText,
  DEEPAUTO_PILOT_REPOSITORY_ID: optionalText,
  DEEPAUTO_ACTIONS_OIDC_AUDIENCE: optionalText,
  DEEPAUTO_ACTIONS_OIDC_REPOSITORY: optionalText,
  DEEPAUTO_ACTIONS_OIDC_REPOSITORY_ID: optionalText,
  DEEPAUTO_ACTIONS_OIDC_WORKFLOW_REF: optionalText,
  DEEPAUTO_ACTIONS_OIDC_REF: optionalText,
  DEEPAUTO_ACTIONS_OIDC_EVENT_NAME: optionalText,
  DEEPAUTO_CODEX_PROXY_PUBLIC_BASE_URL: optionalText,
  DEEPAUTO_CODEX_UPSTREAM_RESPONSES_URL: optionalText,
  DEEPAUTO_CODEX_UPSTREAM_API_KEY: optionalText,
  DEEPAUTO_CODEX_MODEL: optionalText,
  DEEPAUTO_CODEX_SESSION_TOKEN_SECRET: optionalText,
});

type ParsedGatewayEnvironment = z.infer<typeof gatewayConfigurationSchema>;

export type GatewayRuntimeConfiguration = {
  host: string;
  port: number;
  appConfiguration: GatewayConfiguration;
};

export type GatewayRuntime = {
  fetch: ReturnType<typeof createGatewayApp>['fetch'];
  close(): Promise<void>;
};

function requireCompleteGroup<T extends Record<string, string | undefined>>(
  values: T,
): { [Key in keyof T]: string } | undefined {
  const entries = Object.entries(values) as [keyof T, string | undefined][];
  const present = entries.filter(([, value]) => value !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== entries.length) {
    throw new Error('Gateway configuration is invalid');
  }
  return Object.fromEntries(entries) as { [Key in keyof T]: string };
}

function parseGitHubAppCredentials(
  environment: ParsedGatewayEnvironment,
): GitHubAppCredentials | undefined {
  const credentials = requireCompleteGroup({
    appId: environment.GITHUB_APP_ID,
    installationId: environment.GITHUB_APP_INSTALLATION_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
  return credentials;
}

function parseActionsConfiguration(environment: ParsedGatewayEnvironment) {
  const policy = requireCompleteGroup({
    audience: environment.DEEPAUTO_ACTIONS_OIDC_AUDIENCE,
    repository: environment.DEEPAUTO_ACTIONS_OIDC_REPOSITORY,
    repositoryId: environment.DEEPAUTO_ACTIONS_OIDC_REPOSITORY_ID,
    workflowRef: environment.DEEPAUTO_ACTIONS_OIDC_WORKFLOW_REF,
    ref: environment.DEEPAUTO_ACTIONS_OIDC_REF,
    eventName: environment.DEEPAUTO_ACTIONS_OIDC_EVENT_NAME,
  });
  return policy ? { oidcTrustPolicy: policy } : undefined;
}

function parseCodexProxyConfiguration(environment: ParsedGatewayEnvironment) {
  const configuration = requireCompleteGroup({
    publicBaseUrl: environment.DEEPAUTO_CODEX_PROXY_PUBLIC_BASE_URL,
    upstreamResponsesUrl: environment.DEEPAUTO_CODEX_UPSTREAM_RESPONSES_URL,
    upstreamApiKey: environment.DEEPAUTO_CODEX_UPSTREAM_API_KEY,
    model: environment.DEEPAUTO_CODEX_MODEL,
    sessionTokenSecret: environment.DEEPAUTO_CODEX_SESSION_TOKEN_SECRET,
  });
  return configuration;
}

function pilotConfiguration(
  environment: ParsedGatewayEnvironment,
  appCredentials: GitHubAppCredentials | undefined,
  githubActions: GatewayConfiguration['githubActions'],
  codexProxy: GatewayConfiguration['codexProxy'],
): NonNullable<GatewayConfiguration['pilotAdmission']> {
  if (environment.DEEPAUTO_PILOT_ENABLED === 'false') {
    return { enabled: false };
  }
  if (
    !environment.DEEPAUTO_PILOT_MEMBER_ID ||
    !environment.DEEPAUTO_PILOT_REPOSITORY_ID ||
    !environment.GITHUB_BOT_USER_ID ||
    !environment.GITHUB_BOT_LOGIN ||
    !appCredentials ||
    !githubActions ||
    !codexProxy
  ) {
    throw new Error('Gateway configuration is invalid');
  }
  return {
    enabled: true,
    allowedWorkspaceIds: [environment.GITHUB_WORKSPACE_ID],
    allowedMemberIds: [environment.DEEPAUTO_PILOT_MEMBER_ID],
    allowedRepositoryIds: [environment.DEEPAUTO_PILOT_REPOSITORY_ID],
  };
}

export function loadGatewayEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const environmentFile = environment.DEEPAUTO_ENV_FILE ?? '.env.local';
  if (existsSync(environmentFile)) {
    loadEnvironmentFile({
      path: environmentFile,
      quiet: true,
      override: false,
    });
  }
}

export function parseGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayRuntimeConfiguration {
  const parsed = gatewayConfigurationSchema.safeParse(environment);
  if (!parsed.success) throw new Error('Gateway configuration is invalid');

  try {
    const githubAppCredentials = parseGitHubAppCredentials(parsed.data);
    const githubActions = parseActionsConfiguration(parsed.data);
    const codexProxy = parseCodexProxyConfiguration(parsed.data);
    const pilotAdmission = pilotConfiguration(
      parsed.data,
      githubAppCredentials,
      githubActions,
      codexProxy,
    );
    return {
      host: parsed.data.DEEPAUTO_GATEWAY_HOST,
      port: parsed.data.DEEPAUTO_GATEWAY_PORT,
      appConfiguration: {
        prisma: createPrismaClient(parsed.data.DATABASE_URL),
        githubWebhookSecret: parsed.data.GITHUB_WEBHOOK_SECRET,
        githubWorkspaceId: parsed.data.GITHUB_WORKSPACE_ID,
        githubBotMention: parsed.data.GITHUB_BOT_MENTION,
        githubBotUserId: parsed.data.GITHUB_BOT_USER_ID,
        githubPullRequestInspector: githubAppCredentials
          ? createGitHubAppPullRequestInspector(githubAppCredentials)
          : undefined,
        githubActions,
        githubCommentReceiptPublisher: githubAppCredentials
          ? createGitHubAppIssueCommentPublisher(githubAppCredentials)
          : undefined,
        codexProxy,
        pilotAdmission,
      },
    };
  } catch {
    throw new Error('Gateway configuration is invalid');
  }
}

export async function startGatewayRuntime(
  configuration: GatewayRuntimeConfiguration,
  dependencies: { prisma?: PrismaClient } = {},
): Promise<GatewayRuntime> {
  const prisma = dependencies.prisma ?? configuration.appConfiguration.prisma;
  await prisma.$connect();
  const app = createGatewayApp({ ...configuration.appConfiguration, prisma });
  let closed = false;

  return {
    fetch: app.fetch,
    async close() {
      if (closed) return;
      closed = true;
      await prisma.$disconnect();
    },
  };
}
