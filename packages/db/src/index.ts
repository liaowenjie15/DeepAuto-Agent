import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export * from './authorization';
export * from './credential-claim';
export * from './execution-control';
export * from './execution-service';
export * from './execution-user-control';
export * from './generated/prisma/client';
export * from './invocation-service';
export * from './job-lifecycle';
export * from './job-queue';
export * from './lark-message';
export * from './lark-oauth';
export * from './lark-pull-request';
export * from './lark-token-cipher';
export * from './lark-tool-operation';
export * from './lark-write-confirmation';
export * from './test-environment';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}
