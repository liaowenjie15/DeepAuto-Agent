# Video Recording

Capture browser automation sessions as video for debugging, documentation, or verification.

## Recording Starts a Fresh Context — Log In *After* `record start`

`record start` cannot attach a video writer to a live context, so it builds a new one. The new
context starts with **empty `localStorage` and `sessionStorage`** (measured on 0.36.0: seed a
cookie + `localStorage` + `sessionStorage`, then `record start` — only the cookie survives, both
storages read back `null`). Any app that keeps its auth token in `localStorage` — the common case
for bearer-token SPAs — is therefore logged out the moment recording starts, even within the same
`--session`.

```bash
# WRONG: the login is thrown away by record start, and it is not in the video either
agent-browser --session s1 open https://app.example.com/login   # ... log in ...
agent-browser --session s1 record start ./flow.webm
agent-browser --session s1 open https://app.example.com/dashboard   # back at the login wall

# RIGHT: viewport first, then record, then log in inside the recording context
agent-browser --session s1 set viewport 1440 900   # video resolution locks at record start
agent-browser --session s1 record start ./flow.webm
agent-browser --session s1 open https://app.example.com/login   # ... log in ...
agent-browser --session s1 open https://app.example.com/dashboard
```

Logging in inside the recording also puts "which account this run used" into the evidence, which
matters whenever the video has to prove *who* saw the result.

## Basic Recording

```bash
# Start recording
agent-browser record start ./demo.webm

# Perform actions
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "test input"

# Stop and save
agent-browser record stop
```

## Recording Commands

```bash
# Start recording to file
agent-browser record start ./output.webm

# Stop current recording
agent-browser record stop

# Restart with new file (stops current + starts new)
agent-browser record restart ./take2.webm
```

## Use Cases

### Debugging Failed Automation

```bash
#!/bin/bash
# Record automation for debugging

agent-browser record start ./debug-$(date +%Y%m%d-%H%M%S).webm

# Run your automation
agent-browser open https://app.example.com
agent-browser snapshot -i
agent-browser click @e1 || {
    echo "Click failed - check recording"
    agent-browser record stop
    exit 1
}

agent-browser record stop
```

### Documentation Generation

```bash
#!/bin/bash
# Record workflow for documentation

agent-browser record start ./docs/how-to-login.webm

agent-browser open https://app.example.com/login
agent-browser wait 1000  # Pause for visibility

agent-browser snapshot -i
agent-browser fill @e1 "demo@example.com"
agent-browser wait 500

agent-browser fill @e2 "password"
agent-browser wait 500

agent-browser click @e3
agent-browser wait --load networkidle
agent-browser wait 1000  # Show result

agent-browser record stop
```

### CI/CD Test Evidence

```bash
#!/bin/bash
# Record E2E test runs for CI artifacts

TEST_NAME="${1:-e2e-test}"
RECORDING_DIR="./test-recordings"
mkdir -p "$RECORDING_DIR"

agent-browser record start "$RECORDING_DIR/$TEST_NAME-$(date +%s).webm"

# Run test
if run_e2e_test; then
    echo "Test passed"
else
    echo "Test failed - recording saved"
fi

agent-browser record stop
```

## Best Practices

### 1. Add Pauses for Clarity

```bash
# Slow down for human viewing
agent-browser click @e1
agent-browser wait 500  # Let viewer see result
```

### 2. Use Descriptive Filenames

```bash
# Include context in filename
agent-browser record start ./recordings/login-flow-2024-01-15.webm
agent-browser record start ./recordings/checkout-test-run-42.webm
```

### 3. Handle Recording in Error Cases

```bash
#!/bin/bash
set -e

cleanup() {
    agent-browser record stop 2>/dev/null || true
    agent-browser close 2>/dev/null || true
}
trap cleanup EXIT

agent-browser record start ./automation.webm
# ... automation steps ...
```

### 4. Combine with Screenshots

```bash
# Record video AND capture key frames
agent-browser record start ./flow.webm

agent-browser open https://example.com
agent-browser screenshot ./screenshots/step1-homepage.png

agent-browser click @e1
agent-browser screenshot ./screenshots/step2-after-click.png

agent-browser record stop
```

## Output Format

- Default format: WebM (VP8/VP9 codec)
- Compatible with all modern browsers and video players
- Compressed but high quality

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
- Some headless environments may have codec limitations
