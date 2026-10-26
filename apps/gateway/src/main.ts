import {
  loadGatewayEnvironment,
  parseGatewayConfiguration,
  startGatewayRuntime,
} from './gateway-bootstrap';

async function main(): Promise<void> {
  loadGatewayEnvironment();
  const configuration = parseGatewayConfiguration();
  const runtime = await startGatewayRuntime(configuration);
  const server = Bun.serve({
    fetch: runtime.fetch,
    hostname: configuration.host,
    port: configuration.port,
  });
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
    await runtime.close();
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

void main().catch(() => {
  console.error('DeepAuto Gateway failed to start');
  process.exitCode = 1;
});
