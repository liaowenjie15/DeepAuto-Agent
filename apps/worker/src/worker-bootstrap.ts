import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  createLarkTokenCipher,
  createPrismaClient,
  createRedisConnection,
  type PrismaClient,
} from '@deepauto/db';
import { createGitHubAppWorkflowController } from '@deepauto/github';
import { GitHubActionsExecutor } from '@deepauto/runner-manager';
import { config as loadEnvironmentFile } from 'dotenv';
import type IORedis from 'ioredis';
import { z } from 'zod';
import {
  type ExecutionControlWorkerRuntime,
  startExecutionControlWorkerRuntime,
} from './execution-control-worker-runtime';
import {
  type GitHubActionsWorkerRuntime,
  startGitHubActionsWorkerRuntime,
} from './github-actions-worker-runtime';
import { startLarkChatRuntime, type LarkChatRuntime } from './lark-chat-runtime';

const optionalText = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

const workerConfigurationSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  GITHUB_APP_ID: z.string().trim().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().trim().min(1),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.replace(/\\n/g, '\n')),
  DEEPAUTO_GITHUB_REPOSITORY: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/),
  DEEPAUTO_GITHUB_REPOSITORY_ID: z.string().trim().min(1),
  DEEPAUTO_EXECUTION_QUEUE_NAME: optionalText.default('deepauto-execute'),
  DEEPAUTO_EXECUTION_CONTROL_QUEUE_NAME: optionalText.default(
    'deepauto-execution-control',
  ),
  DEEPAUTO_WORKER_ID: optionalText,
  LARK_APP_ID: optionalText,
  LARK_APP_SECRET: optionalText,
  LARK_TENANT_KEY: optionalText,
  LARK_WORKSPACE_ID: optionalText,
  LARK_OAUTH_REDIRECT_URI: optionalText,
  LARK_TOKEN_ENCRYPTION_KEY: optionalText,
  DEEPAUTO_CODEX_UPSTREAM_RESPONSES_URL: optionalText,
  DEEPAUTO_CODEX_UPSTREAM_API_KEY: optionalText,
  DEEPAUTO_CODEX_MODEL: optionalText,
});

export type WorkerConfiguration = z.infer<typeof workerConfigurationSchema>;

export type WorkerRuntime = {
  close(): Promise<void>;
};

export function loadWorkerEnvironment(
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

export function parseWorkerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfiguration {
  const parsed = workerConfigurationSchema.safeParse(environment);
  if (!parsed.success) throw new Error('Worker configuration is invalid');
  const larkFields = [
    parsed.data.LARK_APP_ID,
    parsed.data.LARK_APP_SECRET,
    parsed.data.LARK_TENANT_KEY,
    parsed.data.LARK_WORKSPACE_ID,
    parsed.data.LARK_OAUTH_REDIRECT_URI,
    parsed.data.LARK_TOKEN_ENCRYPTION_KEY,
    parsed.data.DEEPAUTO_CODEX_UPSTREAM_RESPONSES_URL,
    parsed.data.DEEPAUTO_CODEX_UPSTREAM_API_KEY,
    parsed.data.DEEPAUTO_CODEX_MODEL,
  ];
  if (larkFields.some(Boolean) && !larkFields.every(Boolean)) {
    throw new Error('Worker Lark configuration is incomplete');
  }
  return parsed.data;
}

export function startWorkerRuntime(
  configuration: WorkerConfiguration,
  dependencies: {
    prisma?: PrismaClient;
    redis?: IORedis;
    workerId?: string;
  } = {},
): WorkerRuntime {
  const prisma =
    dependencies.prisma ?? createPrismaClient(configuration.DATABASE_URL);
  const redis =
    dependencies.redis ?? createRedisConnection(configuration.REDIS_URL);
  const controller = createGitHubAppWorkflowController({
    appId: configuration.GITHUB_APP_ID,
    installationId: configuration.GITHUB_APP_INSTALLATION_ID,
    privateKey: configuration.GITHUB_APP_PRIVATE_KEY,
  });
  const executor = new GitHubActionsExecutor(
    {
      repository: configuration.DEEPAUTO_GITHUB_REPOSITORY,
      repositoryId: configuration.DEEPAUTO_GITHUB_REPOSITORY_ID,
      workflow: 'deepauto-execute.yml',
      workflowRef: 'main',
    },
    controller,
  );
  const workerId =
    dependencies.workerId ??
    configuration.DEEPAUTO_WORKER_ID ??
    `${hostname()}-${process.pid}`;
  const executionRuntime = startGitHubActionsWorkerRuntime(
    {
      queueName: configuration.DEEPAUTO_EXECUTION_QUEUE_NAME,
      connection: redis,
      workerId,
    },
    {
      prisma,
      redis,
      githubActionsExecutor: executor,
      larkTrust: configuration.LARK_APP_ID && configuration.LARK_TENANT_KEY && configuration.LARK_WORKSPACE_ID
        ? {
            appId: configuration.LARK_APP_ID,
            tenantKey: configuration.LARK_TENANT_KEY,
            workspaceId: configuration.LARK_WORKSPACE_ID,
          }
        : undefined,
    },
  );
  const controlRuntime = startExecutionControlWorkerRuntime(
    {
      queueName: configuration.DEEPAUTO_EXECUTION_CONTROL_QUEUE_NAME,
      connection: redis,
    },
    { prisma, redis, githubActionsExecutor: executor },
  );

  const larkRuntime = configuration.LARK_APP_ID && configuration.LARK_APP_SECRET &&
    configuration.LARK_TENANT_KEY && configuration.LARK_WORKSPACE_ID &&
    configuration.LARK_OAUTH_REDIRECT_URI && configuration.LARK_TOKEN_ENCRYPTION_KEY &&
    configuration.DEEPAUTO_CODEX_UPSTREAM_RESPONSES_URL &&
    configuration.DEEPAUTO_CODEX_UPSTREAM_API_KEY && configuration.DEEPAUTO_CODEX_MODEL
    ? startLarkChatRuntime(prisma, {
        appId: configuration.LARK_APP_ID,
        appSecret: configuration.LARK_APP_SECRET,
        tenantKey: configuration.LARK_TENANT_KEY,
        workspaceId: configuration.LARK_WORKSPACE_ID,
        redirectUri: configuration.LARK_OAUTH_REDIRECT_URI,
        cipher: createLarkTokenCipher(configuration.LARK_TOKEN_ENCRYPTION_KEY),
        responsesUrl: configuration.DEEPAUTO_CODEX_UPSTREAM_RESPONSES_URL,
        apiKey: configuration.DEEPAUTO_CODEX_UPSTREAM_API_KEY,
        model: configuration.DEEPAUTO_CODEX_MODEL,
        repositoryId: configuration.DEEPAUTO_GITHUB_REPOSITORY_ID,
        repository: configuration.DEEPAUTO_GITHUB_REPOSITORY,
      })
    : undefined;

  return createWorkerRuntime(executionRuntime, controlRuntime, larkRuntime, prisma, redis);
}

function createWorkerRuntime(
  executionRuntime: GitHubActionsWorkerRuntime,
  controlRuntime: ExecutionControlWorkerRuntime,
  larkRuntime: LarkChatRuntime | undefined,
  prisma: PrismaClient,
  redis: IORedis,
): WorkerRuntime {
  let closed = false;

  return {
    async close() {
      if (closed) return;
      closed = true;
      await larkRuntime?.close();
      await controlRuntime.close();
      await executionRuntime.close();
      await redis.quit();
      await prisma.$disconnect();
    },
  };
}
