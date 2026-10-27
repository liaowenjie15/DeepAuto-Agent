import {
  loadWorkerEnvironment,
  parseWorkerConfiguration,
  startWorkerRuntime,
} from './worker-bootstrap';

async function main(): Promise<void> {
  loadWorkerEnvironment();
  const runtime = startWorkerRuntime(parseWorkerConfiguration());
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
  };

  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}

void main().catch(() => {
  console.error('DeepAuto Worker failed to start');
  process.exitCode = 1;
});
