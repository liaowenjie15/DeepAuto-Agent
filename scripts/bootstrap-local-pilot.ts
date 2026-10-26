import { config as loadEnvironmentFile } from 'dotenv';
import {
  createPrismaClient,
  MemberRole,
  type PrismaClient,
} from '../packages/db/src/index';

export type PilotBootstrapInput = {
  DATABASE_URL: string;
  DEEPAUTO_PILOT_WORKSPACE_ID: string;
  DEEPAUTO_PILOT_GITHUB_USER_ID: string;
  DEEPAUTO_PILOT_GITHUB_LOGIN: string;
  DEEPAUTO_PILOT_REPOSITORY_ID: string;
};

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: keyof PilotBootstrapInput,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error('Local pilot bootstrap configuration is invalid');
  return value;
}

export function parsePilotBootstrapInput(
  environment: NodeJS.ProcessEnv = process.env,
): PilotBootstrapInput {
  const databaseUrl = requiredEnvironmentValue(environment, 'DATABASE_URL');
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error('Local pilot bootstrap configuration is invalid');
  }
  return {
    DATABASE_URL: databaseUrl,
    DEEPAUTO_PILOT_WORKSPACE_ID: requiredEnvironmentValue(
      environment,
      'DEEPAUTO_PILOT_WORKSPACE_ID',
    ),
    DEEPAUTO_PILOT_GITHUB_USER_ID: requiredEnvironmentValue(
      environment,
      'DEEPAUTO_PILOT_GITHUB_USER_ID',
    ),
    DEEPAUTO_PILOT_GITHUB_LOGIN: requiredEnvironmentValue(
      environment,
      'DEEPAUTO_PILOT_GITHUB_LOGIN',
    ),
    DEEPAUTO_PILOT_REPOSITORY_ID: requiredEnvironmentValue(
      environment,
      'DEEPAUTO_PILOT_REPOSITORY_ID',
    ),
  };
}

export async function bootstrapLocalPilot(
  prisma: PrismaClient,
  input: PilotBootstrapInput,
): Promise<{ memberId: string; repositoryId: string }> {
  return prisma.$transaction(async (transaction) => {
    await transaction.workspace.upsert({
      where: { id: input.DEEPAUTO_PILOT_WORKSPACE_ID },
      update: {},
      create: { id: input.DEEPAUTO_PILOT_WORKSPACE_ID },
    });
    const member = await transaction.workspaceMember.upsert({
      where: {
        workspaceId_githubUserId: {
          workspaceId: input.DEEPAUTO_PILOT_WORKSPACE_ID,
          githubUserId: input.DEEPAUTO_PILOT_GITHUB_USER_ID,
        },
      },
      update: {
        role: MemberRole.ADMIN,
        active: true,
        githubLogin: input.DEEPAUTO_PILOT_GITHUB_LOGIN,
      },
      create: {
        workspaceId: input.DEEPAUTO_PILOT_WORKSPACE_ID,
        role: MemberRole.ADMIN,
        active: true,
        githubUserId: input.DEEPAUTO_PILOT_GITHUB_USER_ID,
        githubLogin: input.DEEPAUTO_PILOT_GITHUB_LOGIN,
      },
    });
    const repository = await transaction.workspaceRepository.upsert({
      where: {
        workspaceId_providerRepositoryId: {
          workspaceId: input.DEEPAUTO_PILOT_WORKSPACE_ID,
          providerRepositoryId: input.DEEPAUTO_PILOT_REPOSITORY_ID,
        },
      },
      update: { enabled: true },
      create: {
        workspaceId: input.DEEPAUTO_PILOT_WORKSPACE_ID,
        providerRepositoryId: input.DEEPAUTO_PILOT_REPOSITORY_ID,
        enabled: true,
      },
    });
    await transaction.auditEvent.create({
      data: {
        workspaceId: input.DEEPAUTO_PILOT_WORKSPACE_ID,
        actorId: member.id,
        action: 'pilot.workspace_bootstrap_applied',
        metadata: {
          provider: 'github',
          githubUserId: input.DEEPAUTO_PILOT_GITHUB_USER_ID,
          providerRepositoryId: input.DEEPAUTO_PILOT_REPOSITORY_ID,
          role: MemberRole.ADMIN,
        },
      },
    });
    return { memberId: member.id, repositoryId: repository.id };
  });
}

async function main(): Promise<void> {
  loadEnvironmentFile({ path: '.env.local', quiet: true, override: false });
  const input = parsePilotBootstrapInput();
  const prisma = createPrismaClient(input.DATABASE_URL);
  try {
    const result = await bootstrapLocalPilot(prisma, input);
    console.log(
      JSON.stringify({
        workspaceId: input.DEEPAUTO_PILOT_WORKSPACE_ID,
        memberId: result.memberId,
        repositoryId: result.repositoryId,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  void main().catch(() => {
    console.error('Local pilot bootstrap failed');
    process.exitCode = 1;
  });
}
