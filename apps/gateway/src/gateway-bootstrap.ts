import { existsSync } from 'node:fs';
import {
  createLarkTokenCipher,
  createPrismaClient,
  createRedisConnection,
  type PrismaClient,
} from '@deepauto/db';
import {
  createGitHubAppIssueCommentPublisher,
  createGitHubAppPullRequestInspector,
  type GitHubAppCredentials,
} from '@deepauto/github';
import { createFeishuClient, createLarkOAuthProvider } from '@deepauto/lark';
import { config as loadEnvironmentFile } from 'dotenv';
import { z } from 'zod';
import { createGatewayApp, type GatewayConfiguration } from './app';
import { createLarkIngress } from './lark-ingress';
import {
  type LarkIngressLeader,
  type LarkIngressLeaseStore,
  startLarkIngressLeader,
} from './lark-ingress-leader';

const optionalText = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.url().optional(),
);

const gatewayConfigurationSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: optionalUrl,
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
  LARK_APP_ID: optionalText,
  LARK_APP_SECRET: optionalText,
  LARK_TENANT_KEY: optionalText,
  LARK_BOT_OPEN_ID: optionalText,
  LARK_WORKSPACE_ID: optionalText,
  LARK_ALLOWED_GROUP_CHAT_IDS: optionalText,
  LARK_OAUTH_REDIRECT_URI: optionalText,
  LARK_TOKEN_ENCRYPTION_KEY: optionalText,
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
  lark?: {
    appId: string;
    appSecret: string;
    tenantKey: string;
    workspaceId: string;
    botOpenId: string;
    allowedGroupChatIds: string[];
    redisUrl: string;
  };
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
    const lark = requireCompleteGroup({
      appId: parsed.data.LARK_APP_ID,
      appSecret: parsed.data.LARK_APP_SECRET,
      tenantKey: parsed.data.LARK_TENANT_KEY,
      workspaceId: parsed.data.LARK_WORKSPACE_ID,
      botOpenId: parsed.data.LARK_BOT_OPEN_ID,
      redirectUri: parsed.data.LARK_OAUTH_REDIRECT_URI,
      encryptionKey: parsed.data.LARK_TOKEN_ENCRYPTION_KEY,
    });
    const redisUrl = parsed.data.REDIS_URL;
    if (lark && !redisUrl) {
      throw new Error('Gateway configuration is invalid');
    }
    if (lark) {
      const redirect = new URL(lark.redirectUri);
      if (
        redirect.pathname !== '/callback' ||
        Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80)) !==
          parsed.data.DEEPAUTO_GATEWAY_PORT ||
        !['https:', 'http:'].includes(redirect.protocol) ||
        (redirect.protocol === 'http:' &&
          !['localhost', '127.0.0.1'].includes(redirect.hostname))
      ) {
        throw new Error('Gateway configuration is invalid');
      }
    }
    const pilotAdmission = pilotConfiguration(
      parsed.data,
      githubAppCredentials,
      githubActions,
      codexProxy,
    );
    return {
      host: parsed.data.DEEPAUTO_GATEWAY_HOST,
      port: parsed.data.DEEPAUTO_GATEWAY_PORT,
      lark:
        lark && redisUrl
          ? {
              appId: lark.appId,
              appSecret: lark.appSecret,
              tenantKey: lark.tenantKey,
              workspaceId: lark.workspaceId,
              botOpenId: lark.botOpenId,
              allowedGroupChatIds: (
                parsed.data.LARK_ALLOWED_GROUP_CHAT_IDS ?? ''
              )
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
              redisUrl,
            }
          : undefined,
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
        larkOAuth: lark
          ? {
              appId: lark.appId,
              tenantKey: lark.tenantKey,
              provider: createLarkOAuthProvider({
                appId: lark.appId,
                appSecret: lark.appSecret,
                redirectUri: lark.redirectUri,
              }),
              cipher: createLarkTokenCipher(lark.encryptionKey),
            }
          : undefined,
      },
    };
  } catch {
    throw new Error('Gateway configuration is invalid');
  }
}

export async function startGatewayRuntime(
  configuration: GatewayRuntimeConfiguration,
  dependencies: {
    prisma?: PrismaClient;
    larkIngressLeaseStore?: LarkIngressLeaseStore;
  } = {},
): Promise<GatewayRuntime> {
  const prisma = dependencies.prisma ?? configuration.appConfiguration.prisma;
  const larkConfiguration = configuration.lark;
  await prisma.$connect();
  const app = createGatewayApp({ ...configuration.appConfiguration, prisma });
  const ownsLarkLeaseStore = Boolean(
    larkConfiguration && !dependencies.larkIngressLeaseStore,
  );
  const larkLeaseStore = larkConfiguration
    ? (dependencies.larkIngressLeaseStore ??
      createRedisConnection(larkConfiguration.redisUrl))
    : undefined;
  let larkLeader: LarkIngressLeader | undefined;
  try {
    larkLeader =
      larkConfiguration && larkLeaseStore
        ? await startLarkIngressLeader({
            store: larkLeaseStore,
            appId: larkConfiguration.appId,
            tenantKey: larkConfiguration.tenantKey,
            workspaceId: larkConfiguration.workspaceId,
            createIngress: (canAccept) =>
              createLarkIngress(
                prisma,
                {
                  ...larkConfiguration,
                  client: createFeishuClient(larkConfiguration),
                },
                undefined,
                canAccept,
              ),
          })
        : undefined;
  } catch {
    await larkLeader?.close();
    if (ownsLarkLeaseStore) await larkLeaseStore?.quit();
    await prisma.$disconnect();
    throw new Error('Lark message ingress failed to start');
  }
  let closed = false;

  return {
    fetch: app.fetch,
    async close() {
      if (closed) return;
      closed = true;
      await larkLeader?.close();
      if (ownsLarkLeaseStore) await larkLeaseStore?.quit();
      await prisma.$disconnect();
    },
  };
}
