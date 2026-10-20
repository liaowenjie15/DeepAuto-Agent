import { defineConfig } from 'prisma/config';

const defaultTestDatabaseUrl =
  'postgresql://deepauto_test:deepauto_test@localhost:5433/deepauto_test?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? defaultTestDatabaseUrl,
  },
});
