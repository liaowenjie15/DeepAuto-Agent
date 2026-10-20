const [scenario, attemptId] = process.argv.slice(2);

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (!attemptId) process.exit(2);

switch (scenario) {
  case 'completed':
    emit({ type: 'started', attemptId });
    emit({ type: 'progress', attemptId, message: 'running' });
    emit({ type: 'artifact', attemptId, name: 'test_result', value: 'passed' });
    emit({ type: 'completed', attemptId });
    break;
  case 'workspace':
    emit({ type: 'started', attemptId });
    emit({
      type: 'artifact',
      attemptId,
      name: 'workspace',
      value: process.cwd(),
    });
    emit({ type: 'completed', attemptId });
    break;
  case 'failed':
    emit({ type: 'started', attemptId });
    emit({ type: 'failed', attemptId, reason: 'runtime failed' });
    process.exitCode = 1;
    break;
  case 'no-terminal':
    emit({ type: 'started', attemptId });
    process.exitCode = 1;
    break;
  case 'wrong-attempt':
    emit({ type: 'started', attemptId: 'wrong-attempt' });
    break;
  case 'duplicate-terminal':
    emit({ type: 'started', attemptId });
    emit({ type: 'completed', attemptId });
    emit({ type: 'completed', attemptId });
    break;
  case 'hang':
    emit({ type: 'started', attemptId });
    setInterval(() => undefined, 1_000);
    break;
  default:
    process.exitCode = 2;
}
