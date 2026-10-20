const expectedDatabaseName = 'deepauto_test';
const expectedDatabasePort = '5433';
const expectedRedisPort = '6380';
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export type TestEnvironment = {
  databaseUrl: string;
  redisUrl: string;
};

function assertLocalUrl(rawUrl: string, serviceName: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${serviceName} must be a valid URL`);
  }

  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `${serviceName} must point to an isolated local test service`,
    );
  }

  return url;
}

export function getTestEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TestEnvironment {
  if (environment.NODE_ENV !== 'test') {
    throw new Error('Integration tests require NODE_ENV=test');
  }

  const databaseUrl = environment.DATABASE_URL;
  const redisUrl = environment.REDIS_URL;

  if (!databaseUrl || !redisUrl) {
    throw new Error('Integration tests require DATABASE_URL and REDIS_URL');
  }

  const database = assertLocalUrl(databaseUrl, 'DATABASE_URL');
  const redis = assertLocalUrl(redisUrl, 'REDIS_URL');

  if (database.pathname !== `/${expectedDatabaseName}`) {
    throw new Error(
      `DATABASE_URL must use the ${expectedDatabaseName} database`,
    );
  }

  if (database.port !== expectedDatabasePort) {
    throw new Error(
      `DATABASE_URL must use the ${expectedDatabasePort} test port`,
    );
  }

  if (redis.port !== expectedRedisPort) {
    throw new Error(`REDIS_URL must use the ${expectedRedisPort} test port`);
  }

  return { databaseUrl, redisUrl };
}
