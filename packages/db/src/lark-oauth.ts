import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';
import type { LarkTokenCipher } from './lark-token-cipher';

const allowedUserScopes = new Set([
  'offline_access',
  'docx:document:readonly',
  'docx:document:create',
  'docx:document:write_only',
  'bitable:app:readonly',
  'base:app:create',
  'base:record:create',
  'base:record:update',
  'base:record:delete',
  'base:table:create',
  'base:table:delete',
  'base:field:create',
  'base:field:update',
  'base:field:delete',
  'space:document:move',
  'space:document:delete',
  'docs:permission.member:create',
  'docs:permission.member:delete',
]);

export type LarkOAuthState = {
  workspaceId: string;
  actorId: string;
  tenantKey: string;
  scopes: string[];
  expectedOpenId: string;
};

export type LarkStoredTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  scopes: string[];
};

function stateHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenContext(input: {
  workspaceId: string;
  actorId: string;
  appId: string;
  tenantKey: string;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.actorId,
    input.appId,
    input.tenantKey,
  ]);
}

export async function createLarkOAuthState(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    actorId: string;
    tenantKey: string;
    scopes: readonly string[];
  },
): Promise<string> {
  const scopes = [...new Set([...input.scopes, 'offline_access'])];
  if (scopes.some((scope) => !allowedUserScopes.has(scope))) {
    throw new Error('Lark OAuth scope is not registered');
  }
  const member = await prisma.workspaceMember.findFirst({
    where: {
      id: input.actorId,
      workspaceId: input.workspaceId,
      active: true,
      larkOpenId: { not: null },
    },
    select: { id: true },
  });
  if (!member) throw new Error('Lark OAuth member is unavailable');

  const state = randomBytes(32).toString('base64url');
  await prisma.larkOAuthState.create({
    data: {
      stateHash: stateHash(state),
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      tenantKey: input.tenantKey,
      scopes,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });
  return state;
}

export async function consumeLarkOAuthState(
  prisma: PrismaClient,
  state: string,
  tenantKey: string,
): Promise<LarkOAuthState | null> {
  const hash = stateHash(state);
  const usedAt = new Date();
  const claimed = await prisma.larkOAuthState.updateMany({
    where: {
      stateHash: hash,
      tenantKey,
      usedAt: null,
      expiresAt: { gt: usedAt },
    },
    data: { usedAt },
  });
  if (claimed.count !== 1) return null;
  const stored = await prisma.larkOAuthState.findUnique({
    where: { stateHash: hash },
    include: { member: { select: { active: true, larkOpenId: true } } },
  });
  if (!stored?.member.active || !stored.member.larkOpenId) return null;
  return {
    workspaceId: stored.workspaceId,
    actorId: stored.actorId,
    tenantKey: stored.tenantKey,
    scopes: stored.scopes,
    expectedOpenId: stored.member.larkOpenId,
  };
}

export async function saveLarkUserConnection(
  prisma: PrismaClient,
  input: {
    state: LarkOAuthState;
    appId: string;
    openId: string;
    tenantKey: string;
    tokens: LarkStoredTokens;
    cipher: LarkTokenCipher;
  },
): Promise<boolean> {
  if (
    input.openId !== input.state.expectedOpenId ||
    input.tenantKey !== input.state.tenantKey ||
    input.state.scopes.some((scope) => !input.tokens.scopes.includes(scope))
  ) {
    return false;
  }
  const member = await prisma.workspaceMember.findFirst({
    where: {
      id: input.state.actorId,
      workspaceId: input.state.workspaceId,
      active: true,
      larkOpenId: input.openId,
    },
    select: { id: true },
  });
  if (!member) return false;

  const key = {
    workspaceId: input.state.workspaceId,
    actorId: input.state.actorId,
    appId: input.appId,
    tenantKey: input.tenantKey,
  };
  const context = tokenContext(key);
  const data = {
    openId: input.openId,
    accessTokenEncrypted: input.cipher.encrypt(
      input.tokens.accessToken,
      context,
    ),
    refreshTokenEncrypted: input.cipher.encrypt(
      input.tokens.refreshToken,
      context,
    ),
    accessExpiresAt: input.tokens.accessExpiresAt,
    refreshExpiresAt: input.tokens.refreshExpiresAt,
    refreshUncertainAt: null,
    scopes: input.tokens.scopes,
  };
  await prisma.larkUserConnection.upsert({
    where: {
      workspaceId_actorId_appId_tenantKey: key,
    },
    create: { ...key, ...data },
    update: data,
  });
  return true;
}

export async function getLarkUserAccessToken(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    actorId: string;
    appId: string;
    tenantKey: string;
    requiredScopes: readonly string[];
    cipher: LarkTokenCipher;
    refresh: (refreshToken: string) => Promise<LarkStoredTokens>;
  },
): Promise<string | null> {
  const key = {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    appId: input.appId,
    tenantKey: input.tenantKey,
  };
  const connection = await prisma.larkUserConnection.findUnique({
    where: { workspaceId_actorId_appId_tenantKey: key },
    include: { member: { select: { active: true, larkOpenId: true } } },
  });
  if (
    !connection?.member.active ||
    connection.member.larkOpenId !== connection.openId ||
    connection.refreshUncertainAt ||
    input.requiredScopes.some((scope) => !connection.scopes.includes(scope))
  ) {
    return null;
  }
  const context = tokenContext(key);
  if (connection.accessExpiresAt.getTime() > Date.now() + 60_000) {
    return input.cipher.decrypt(connection.accessTokenEncrypted, context);
  }
  if (connection.refreshExpiresAt.getTime() <= Date.now()) return null;

  return prisma.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id" FROM "LarkUserConnection"
        WHERE "id" = ${connection.id} FOR UPDATE
      `;
      const current = await transaction.larkUserConnection.findUnique({
        where: { id: connection.id },
        include: { member: { select: { active: true, larkOpenId: true } } },
      });
      if (
        !current?.member.active ||
        current.member.larkOpenId !== current.openId ||
        current.workspaceId !== input.workspaceId ||
        current.actorId !== input.actorId ||
        current.appId !== input.appId ||
        current.tenantKey !== input.tenantKey ||
        current.refreshUncertainAt ||
        input.requiredScopes.some((scope) => !current.scopes.includes(scope))
      ) {
        return null;
      }
      if (current.accessExpiresAt.getTime() > Date.now() + 60_000) {
        return input.cipher.decrypt(current.accessTokenEncrypted, context);
      }
      if (current.refreshExpiresAt.getTime() <= Date.now()) return null;

      let tokens: LarkStoredTokens;
      try {
        tokens = await input.refresh(
          input.cipher.decrypt(current.refreshTokenEncrypted, context),
        );
      } catch {
        await transaction.larkUserConnection.update({
          where: { id: current.id },
          data: { refreshUncertainAt: new Date() },
        });
        return null;
      }
      if (
        input.requiredScopes.some((scope) => !tokens.scopes.includes(scope)) ||
        !tokens.scopes.includes('offline_access')
      ) {
        await transaction.larkUserConnection.update({
          where: { id: current.id },
          data: { refreshUncertainAt: new Date() },
        });
        return null;
      }
      await transaction.larkUserConnection.update({
        where: { id: current.id },
        data: {
          accessTokenEncrypted: input.cipher.encrypt(
            tokens.accessToken,
            context,
          ),
          refreshTokenEncrypted: input.cipher.encrypt(
            tokens.refreshToken,
            context,
          ),
          accessExpiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          scopes: tokens.scopes,
          refreshUncertainAt: null,
        },
      });
      return tokens.accessToken;
    },
    { timeout: 20_000 },
  );
}
