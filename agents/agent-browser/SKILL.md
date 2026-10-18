---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*)
---

# Browser Automation with agent-browser

The CLI uses Chrome/Chromium via CDP directly. Install via `npm i -g agent-browser` / `bun add -g agent-browser`, then `agent-browser install` to download Chrome for Testing. Run `agent-browser upgrade` to update.

## Core Workflow

Every browser automation follows this pattern:

1. **Navigate**: `agent-browser open <url>`
2. **Snapshot**: `agent-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait 2000
agent-browser snapshot -i  # Check result
```

## Command Chaining

Commands can be chained with `&&` in a single shell invocation. The browser persists between commands via a background daemon, so chaining is safe and more efficient than separate calls.

```bash
# Chain open + snapshot in one call (open already waits for page load)
agent-browser open https://example.com && agent-browser snapshot -i

# Chain multiple interactions
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3

# Navigate and capture
agent-browser open https://example.com && agent-browser screenshot
```

**When to chain:** Use `&&` when you don't need to read the output of an intermediate command before proceeding (e.g., open + wait + screenshot). Run commands separately when you need to parse the output first (e.g., snapshot to discover refs, then interact using those refs).

## Essential Commands

```bash
# Batch: ALWAYS use batch for 2+ sequential commands. Commands run in order.
agent-browser batch "open https://example.com" "snapshot -i"
agent-browser batch "open https://example.com" "screenshot"
agent-browser batch "click @e1" "wait 1000" "screenshot"

# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser close                   # Close browser
agent-browser close --all             # Close all active sessions

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i --urls      # Include href URLs for links
agent-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press key
agent-browser keyboard type "text"    # Type at current focus (no selector)
agent-browser keyboard inserttext "text"  # Insert without key events
agent-browser scroll down 500         # Scroll page
agent-browser scroll down 500 --selector "div.content"  # Scroll within a specific container

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait 2000               # Wait milliseconds
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait --text "Welcome"   # Wait for text to appear (substring match)
agent-browser wait --fn "!document.body.innerText.includes('Loading...')"  # Wait for text to disappear
agent-browser wait "#spinner" --state hidden  # Wait for element to disappear

# Downloads
agent-browser download @e1 ./file.pdf          # Click element to trigger download
agent-browser wait --download ./output.zip     # Wait for any download to complete
agent-browser --download-path ./downloads open <url>  # Set default download directory

# Tab management
agent-browser tab list                         # List all open tabs
agent-browser tab new                          # Open a blank new tab
agent-browser tab new https://example.com      # Open URL in a new tab
agent-browser tab 2                            # Switch to tab by index (0-based)
agent-browser tab close                        # Close the current tab
agent-browser tab close 2                      # Close tab by index

# Network
agent-browser network requests                 # Inspect tracked requests
agent-browser network requests --type xhr,fetch  # Filter by resource type
agent-browser network requests --method POST   # Filter by HTTP method
agent-browser network requests --status 2xx    # Filter by status (200, 2xx, 400-499)
agent-browser network request <requestId>      # View full request/response detail
agent-browser network route "**/api/*" --abort  # Block matching requests
agent-browser network route "**/data.json" --body '{"mock":true}'  # Reply with a mocked body
agent-browser network unroute                  # Remove all routes (or pass a URL pattern)
agent-browser network har start                # Start HAR recording
agent-browser network har stop ./capture.har   # Stop and save HAR file

# Viewport & Device Emulation
agent-browser set viewport 1920 1080          # Set viewport size (default: 1280x720)
agent-browser set viewport 1920 1080 2        # 2x retina (same CSS size, higher res screenshots)
agent-browser set device "iPhone 14"          # Emulate device (viewport + user agent)

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser screenshot --screenshot-dir ./shots  # Save to custom directory
agent-browser screenshot --screenshot-format jpeg --screenshot-quality 80
agent-browser pdf output.pdf          # Save as PDF

# Dialogs (alert, confirm, prompt, beforeunload)
# By default, alert and beforeunload dialogs are auto-accepted so they never block the agent.
# confirm and prompt dialogs still require explicit handling.
# Use --no-auto-dialog (or AGENT_BROWSER_NO_AUTO_DIALOG=1) to disable automatic handling.
agent-browser dialog accept              # Accept dialog
agent-browser dialog accept "my input"   # Accept prompt dialog with text
agent-browser dialog dismiss             # Dismiss/cancel dialog
agent-browser dialog status              # Check if a dialog is currently open

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element
```

## Batch Execution

ALWAYS use `batch` when running 2+ commands in sequence. Batch executes commands in order, so dependent commands (like navigate then screenshot) work correctly. Each quoted argument is a separate command.

```bash
# Navigate and take a snapshot
agent-browser batch "open https://example.com" "snapshot -i"

# Navigate, snapshot, and screenshot in one call
agent-browser batch "open https://example.com" "snapshot -i" "screenshot"

# Click, wait, then screenshot
agent-browser batch "click @e1" "wait 1000" "screenshot"

# With --bail to stop on first error
agent-browser batch --bail "open https://example.com" "click @e1" "screenshot"
```

Only use a single command (not batch) when you need to read the output before deciding the next command. For example, you must run `snapshot -i` as a single command when you need to read the refs to decide what to click. After reading the snapshot, batch the remaining steps.

Stdin mode is also supported for programmatic use:

```bash
echo '[["open","https://example.com"],["screenshot"]]' | agent-browser batch --json
agent-browser batch --bail < commands.json
```

## Efficiency Strategies

These patterns minimize tool calls and token usage.

**Use `--urls` to avoid re-navigation.** When you need to visit links from a page, use `snapshot -i --urls` to get all href URLs upfront. Then `open` each URL directly instead of clicking refs and navigating back.

**Snapshot once, act many times.** Never re-snapshot the same page. Extract all needed info (refs, URLs, text) from a single snapshot, then batch the remaining actions.

**Multi-page workflow (e.g. "visit N sites and screenshot each"):**

```bash
# 1. Get all URLs in one call
agent-browser batch "open https://news.ycombinator.com" "snapshot -i --urls"
# Read output to extract URLs, then visit each directly:
# 2. One batch per target site
agent-browser batch "open https://github.com/example/repo" "screenshot"
agent-browser batch "open https://example.com/article" "screenshot"
agent-browser batch "open https://other.com/page" "screenshot"
```

This approach uses 4 tool calls instead of 14+. Never go back to the listing page between visits.

## Common Patterns

### Form Submission

```bash
# Navigate and get the form structure
agent-browser batch "open https://example.com/signup" "snapshot -i"
# Read the snapshot output to identify form refs, then fill and submit
agent-browser batch "fill @e1 \"Jane Doe\"" "fill @e2 \"jane@example.com\"" "select @e3 \"California\"" "check @e4" "click @e5" "wait 2000"
```

### Authentication

If a task requires login, the simplest path is `--session-name`, which auto-saves cookies + localStorage between invocations:

```bash
# First run: log in manually via the automation
agent-browser --session-name myapp open https://app.example.com/login
# ... fill credentials, click submit ...
agent-browser close  # State auto-saved

# Next time: state auto-restored
agent-browser --session-name myapp open https://app.example.com/dashboard
```

For more involved flows (auth vault with encrypted credentials, manual state save/load, OAuth, 2FA), see [references/authentication.md](references/authentication.md).

If the run is also being recorded, log in **after** `record start`: recording builds a fresh context
with empty `localStorage` / `sessionStorage`, so a login done before it is gone. See
[references/video-recording.md](references/video-recording.md).

### Working with Iframes

Iframe content is automatically inlined in snapshots. Refs inside iframes carry frame context, so you can interact with them directly.

```bash
agent-browser batch "open https://example.com/checkout" "snapshot -i"
# @e1 [heading] "Checkout"
# @e2 [Iframe] "payment-frame"
#   @e3 [input] "Card number"
#   @e4 [input] "Expiry"
#   @e5 [button] "Pay"

# Interact directly — no frame switch needed
agent-browser batch "fill @e3 \"4111111111111111\"" "fill @e4 \"12/28\"" "click @e5"

# To scope a snapshot to one iframe:
agent-browser batch "frame @e2" "snapshot -i"
agent-browser frame main          # Return to main frame
```

### Data Extraction

```bash
agent-browser batch "open https://example.com/products" "snapshot -i"
# Read snapshot to find element refs, then extract
agent-browser get text @e5           # Get specific element text

# JSON output for parsing
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

### Viewport & Responsive Testing

```bash
# Set a custom viewport size (default is 1280x720)
agent-browser set viewport 1920 1080
agent-browser screenshot desktop.png

# Test mobile-width layout
agent-browser set viewport 375 812
agent-browser screenshot mobile.png

# Retina/HiDPI: same CSS layout at 2x pixel density
agent-browser set viewport 1920 1080 2
agent-browser screenshot retina.png

# Device emulation (sets viewport + user agent in one step)
agent-browser set device "iPhone 14"
agent-browser screenshot device.png
```

### Local Files (PDFs, HTML)

```bash
agent-browser --allow-file-access open file:///path/to/document.pdf
agent-browser --allow-file-access open file:///path/to/page.html
agent-browser screenshot output.png
```

## Security

All security features are opt-in. By default, agent-browser imposes no restrictions on navigation, actions, or output.

### Content Boundaries (Recommended for AI Agents)

Enable `--content-boundaries` to wrap page-sourced output in markers that help LLMs distinguish tool output from untrusted page content:

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
agent-browser snapshot
# Output:
# --- AGENT_BROWSER_PAGE_CONTENT nonce=<hex> origin=https://example.com ---
# [accessibility tree]
# --- END_AGENT_BROWSER_PAGE_CONTENT nonce=<hex> ---
```

### Domain Allowlist

Restrict navigation to trusted domains. Wildcards like `*.example.com` also match the bare domain. Sub-resource requests and WebSocket connections to non-allowed domains are also blocked.

```bash
export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"
agent-browser open https://example.com        # OK
agent-browser open https://malicious.com       # Blocked
```

### Output Limits

Prevent context flooding from large pages:

```bash
export AGENT_BROWSER_MAX_OUTPUT=50000
```

## Diffing (Verifying Changes)

Use `diff snapshot` after performing an action to verify it had the intended effect. This compares the current accessibility tree against the last snapshot taken in the session.

```bash
# Typical workflow: snapshot -> action -> diff
agent-browser snapshot -i          # Take baseline snapshot
agent-browser click @e2            # Perform action
agent-browser diff snapshot        # See what changed (auto-compares to last snapshot)
```

For visual regression testing:

```bash
agent-browser screenshot baseline.png
# ... time passes or changes are made ...
agent-browser diff screenshot --baseline baseline.png
```

`diff snapshot` output uses `+` for additions and `-` for removals, similar to git diff. `diff screenshot` produces a diff image with changed pixels highlighted in red, plus a mismatch percentage.

## Timeouts and Slow Pages

The default timeout is 25 seconds. Override with `AGENT_BROWSER_DEFAULT_TIMEOUT` (milliseconds).

**Important:** `open` already waits for the page `load` event before returning. In most cases, no additional wait is needed before taking a snapshot or screenshot. Only add an explicit wait when content loads asynchronously after the initial page load.

```bash
# Wait for a specific element to appear (preferred for dynamic content)
agent-browser wait "#content"
agent-browser wait @e1

# Wait a fixed duration (good default for slow SPAs)
agent-browser wait 2000

# Wait for a specific URL pattern (useful after redirects)
agent-browser wait --url "**/dashboard"

# Wait for text to appear on the page
agent-browser wait --text "Results loaded"

# Wait for a JavaScript condition
agent-browser wait --fn "document.querySelectorAll('.item').length > 0"
```

**Avoid `wait --load networkidle`** unless you are certain the site has no persistent network activity. Ad-heavy sites, sites with analytics/tracking, and sites with websockets will cause `networkidle` to hang indefinitely. Prefer `wait 2000` or `wait <selector>` instead.

## Mocking Grain's tRPC Responses

**`--body` cannot mock a cross-origin request.** The fulfilled response carries no
`access-control-allow-origin` header and `route` has no flag to add one, so the browser
rejects it and the `fetch` fails outright. Measured 2026-08-11: same-origin route returns
`200` with the mocked body; the identical route against another origin returns
`ERR:Failed to fetch`.

**Do not rely on static route mocking in Grain's deployed browser E2E.** The configured API
URL is cross-origin in the environments used by those tests:

- **Mobile web previews**: `apps/mobile/eas.json` points preview builds at
  `https://api.neodrop.ai`, while the page runs on `*.mobile.dev.neodrop.ai`. #8017's mobile
  E2E lost all three scenarios to exactly this. Native store builds are outside
  `agent-browser`; React Native fetch is not governed by browser CORS.
- **Web PR previews / dev**: the browser client's base URL is
  `NEXT_PUBLIC_API_URL || API_URL` (`apps/web/src/trpc/query-client.ts`), which CI sets to a
  dedicated preview API origin. `applyApiAccelerationOverrideForChinaUser` deliberately
  skips these non-production origins, so the request remains cross-origin.
- **Web production**: requests start on `https://api.neodrop.ai`. The China-route probe may
  later make eligible tRPC requests same-origin through `/trpc/*`, so a route can work in
  that runtime state; tests cannot assume the probe will activate or that a procedure is
  eligible for the rewrite.

When the request remains cross-origin, `fetch` rejects. Depending on the query's retry and
rendering path, the UI can stay empty or look hung instead of exposing the CORS failure.

`network route ... --body` replaces the response body of matching requests. Getting the
body shape wrong is equally silent — the client just never resolves the query, so the list
or page under test stays empty.

Grain's tRPC clients are **not** uniform, so check which link serves the procedure you are
mocking before writing the body:

| Caller | Link | Response shape / mocking guidance |
|---|---|---|
| Mobile client (`apps/mobile/libs/trpc/client.tsx`), except paths containing `generate` / `analyze` | `httpLink`, `transformer: superjson` | single object: `{"result":{"data":{"json":<payload>}}}` |
| Mobile paths containing `generate` / `analyze` | `httpBatchStreamLink` | streamed batch — mocking a static body is not reliable, prefer seeding real data |
| Web browser client (`apps/web/src/trpc/client.tsx`), CDN-cacheable procedures | `httpLink`, `transformer: superjson` | same single-object shape as mobile `httpLink` |
| Web browser client, non-stream / long-running procedures | `httpBatchLink` | batched JSON — a single-object static body is the wrong shape, prefer seeding real data |
| Web browser client, all other procedures | `httpBatchStreamLink` | streamed batch — mocking a static body is not reliable, prefer seeding real data |
| Web server-side prefetch (`apps/web/src/trpc/server.tsx`) | `httpLink` | never reaches the browser, cannot be routed |

`superjson`'s `meta` may be omitted when the payload has no `Date` / `Map` / `Set` values;
plain strings, numbers, `null` and nested objects round-trip through `json` alone.

```bash
# Same-origin only — deployed E2E must not assume the runtime request URL is same-origin.
# Mobile notification.list is served by httpLink; Web notification.list uses
# httpBatchStreamLink, so this static body is the wrong shape there anyway.
agent-browser network route "**/trpc/notification.list*" \
  --body '{"result":{"data":{"json":{"items":[],"nextCursor":null}}}}'
```

**Seed real rows instead of mocking** — this is the reliable default for deployed E2E, and
is required when the request remains cross-origin (including PR and mobile web previews).
A route only fakes what the browser sees, so it proves nothing about the server contract,
and any drift between the mocked shape and the real procedure output silently invalidates
the test. When the scenario needs a specific database row, create it through the product's
own path or the internal MCP tools and let the real request run.

## JavaScript Dialogs (alert / confirm / prompt)

When a page opens a JavaScript dialog (`alert()`, `confirm()`, or `prompt()`), it blocks all other browser commands until the dialog is dismissed. If commands start timing out unexpectedly, check for a pending dialog:

```bash
agent-browser dialog status              # Check if a dialog is blocking
agent-browser dialog accept              # Accept (click OK)
agent-browser dialog accept "my input"   # Accept prompt with text
agent-browser dialog dismiss             # Dismiss (click Cancel)
```

When a dialog is pending, all command responses include a `warning` field indicating the dialog type and message.

## Session Management and Cleanup

Always close your browser session when done to avoid leaked processes:

```bash
agent-browser close                    # Close default session
agent-browser --session agent1 close   # Close specific session
agent-browser close --all              # Close all active sessions
```

If a previous session was not closed properly, the daemon may still be running. Use `agent-browser close` to clean it up.

To auto-shutdown the daemon after a period of inactivity (useful for ephemeral/CI environments):

```bash
AGENT_BROWSER_IDLE_TIMEOUT_MS=60000 agent-browser open example.com
```

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

```bash
agent-browser click @e5              # Navigates to new page
agent-browser snapshot -i            # MUST re-snapshot
agent-browser click @e1              # Use new refs
```

## Annotated Screenshots (Vision Mode)

Use `--annotate` to take a screenshot with numbered labels overlaid on interactive elements. Each label `[N]` maps to ref `@eN`. This also caches refs, so you can interact with elements immediately without a separate snapshot.

```bash
agent-browser screenshot --annotate
# Output includes the image path and a legend:
#   [1] @e1 button "Submit"
#   [2] @e2 link "Home"
#   [3] @e3 textbox "Email"
agent-browser click @e2              # Click using ref from annotated screenshot
```

Use annotated screenshots when:

- The page has unlabeled icon buttons or visual-only elements
- You need to verify visual layout or styling
- Canvas or chart elements are present (invisible to text snapshots)
- You need spatial reasoning about element positions

## Semantic Locators (Alternative to Refs)

When refs are unavailable or unreliable, use semantic locators:

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

## JavaScript Evaluation (eval)

Use `eval` to run JavaScript in the browser context. **Shell quoting can corrupt complex expressions** — use `--stdin` or `-b` to avoid issues.

```bash
# Simple expressions work with regular quoting
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'

# Complex JS: use --stdin with heredoc (RECOMMENDED)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF

# Alternative: base64 encoding (avoids all shell escaping issues)
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll("a")).map(a => a.href)' | base64)"
```

**Why this matters:** When the shell processes your command, inner double quotes, `!` characters (history expansion), backticks, and `$()` can all corrupt the JavaScript before it reaches agent-browser. The `--stdin` and `-b` flags bypass shell interpretation entirely.

**Rules of thumb:**

- Single-line, no nested quotes → regular `eval 'expression'` with single quotes is fine
- Nested quotes, arrow functions, template literals, or multiline → use `eval --stdin <<'EVALEOF'`
- Programmatic/generated scripts → use `eval -b` with base64

## Deep-Dive Documentation

| Reference                                                            | When to Use                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| [references/snapshot-refs.md](references/snapshot-refs.md)           | Ref lifecycle, invalidation rules, troubleshooting        |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md)         | Login flows, OAuth, 2FA handling, state reuse             |

For full CLI options, run `agent-browser --help` or `agent-browser <command> --help`.

## Ready-to-Use Templates

| Template                                                                 | Description                         |
| ------------------------------------------------------------------------ | ----------------------------------- |
| [templates/form-automation.sh](templates/form-automation.sh)             | Form filling with validation        |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) | Login once, reuse state             |
| [templates/capture-workflow.sh](templates/capture-workflow.sh)           | Content extraction with screenshots |

```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
