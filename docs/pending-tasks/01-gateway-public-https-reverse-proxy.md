# Pending Task: Gateway Public HTTPS Reverse Proxy

> Status: Not started
>
> Recorded: 2026-10-21

## Purpose

Make the DeepAuto Gateway reachable by GitHub-hosted Actions runners through a
trusted public HTTPS URL. The GitHub Actions repository variable
`DEEPAUTO_GATEWAY_URL` must point to that URL.

No reverse proxy, public domain, DNS record, TLS certificate, firewall rule, or
GitHub Actions variable has been configured as part of this task record.

## Required Result

The isolated repository must eventually have this repository Actions Variable:

```text
DEEPAUTO_GATEWAY_URL=https://gateway.example.com
```

Replace `gateway.example.com` with the production Gateway domain. Use only the
base URL: do not include a trailing slash, port, or API path.

The workflow appends its own paths, including:

```text
/github/actions/executions/<execution_id>/bootstrap
/github/actions/executions/<execution_id>/codex/session
/github/actions/executions/<execution_id>/callback
/codex/proxy/v1/responses
```

## Preconditions

- Select the actual isolated GitHub repository, domain name, deployment
  platform, and Gateway runtime port.
- Ensure the Gateway process is healthy before adding a reverse proxy. The
  proxy does not start the Gateway process.
- Create a DNS record for the Gateway domain that resolves to the public
  ingress/load balancer.
- Permit inbound TCP ports `80` and `443` at the hosting provider and host
  firewall, when self-hosting.
- Keep the internal Gateway port private. Do not expose the application port
  directly to the public internet.
- Configure the Gateway's GitHub Actions OIDC trust policy before exercising a
  production workflow.

## Implementation Options

### Option A: Managed HTTPS Platform

Use a managed service such as a cloud application platform, container service,
or load balancer that provides a public HTTPS URL and TLS certificate.

1. Deploy Gateway as an HTTPS web service.
2. Bind a custom domain, or use the platform-provided HTTPS domain.
3. Configure the platform's backend target to the Gateway service port.
4. Verify the platform forwards the `Authorization` header unchanged.
5. Set `DEEPAUTO_GATEWAY_URL` to the resulting HTTPS base URL.

### Option B: Self-Hosted Caddy Reverse Proxy

Use this only after the Gateway is running on a private local interface, for
example `127.0.0.1:3000`.

Example `Caddyfile`:

```caddy
gateway.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

This places Caddy on ports `80` and `443`, obtains and renews TLS certificates,
and forwards all Gateway routes to the local process. Do not run Caddy and
Nginx as competing listeners on the same ports.

### Option C: Self-Hosted Nginx Reverse Proxy

Use Nginx instead of Caddy when TLS certificate provisioning and renewal are
operated separately.

```nginx
server {
    listen 443 ssl http2;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Authorization $http_authorization;
    }
}
```

## Security Requirements

- Require HTTPS with a publicly trusted certificate; do not set an `http://`
  Gateway URL.
- Do not place upstream API keys, GitHub App credentials, GitHub OIDC tokens,
  or proxy session tokens in `DEEPAUTO_GATEWAY_URL` or any repository variable.
- Keep the Gateway application's listening port private and expose only the
  reverse-proxy/load-balancer HTTPS endpoint.
- Preserve the incoming `Authorization` header. The Gateway validates the
  GitHub Actions OIDC token at the bootstrap, session, and callback endpoints.
- Rate-limit and log at the ingress layer without recording authorization
  header values.

## Verification

After the Gateway OIDC configuration is active, run this from a network outside
the Gateway host:

```bash
curl -i -X POST \
  https://gateway.example.com/github/actions/executions/test/bootstrap
```

An HTTP `401` response is expected without a GitHub Actions OIDC token. It
confirms DNS, HTTPS, reverse-proxy routing, and Gateway request handling are
reachable. A `502` generally means the reverse proxy cannot reach the local
Gateway process; a DNS or TLS error indicates public ingress is incomplete.

Finally, dispatch one controlled execution from the isolated repository and
confirm that it can reach the bootstrap, session, and callback endpoints.

## Completion Criteria

- `DEEPAUTO_GATEWAY_URL` contains the approved HTTPS base URL in the isolated
  repository's Actions Variables.
- A GitHub-hosted Actions runner can reach the Gateway through valid HTTPS.
- The Gateway's internal application port is not publicly reachable.
- Gateway OIDC validation accepts only the approved isolated repository,
  workflow, ref, event, issuer, and audience.
- A controlled workflow run reaches Gateway successfully without exposing any
  credential in source control or logs.

## Related Code

- `.github/workflows/deepauto-execute.yml:21` reads
  `DEEPAUTO_GATEWAY_URL` from repository Actions Variables.
- `.github/workflows/deepauto-execute.yml:34` requires the URL to use HTTPS.
- `apps/gateway/src/app.ts:204` defines the GitHub Actions session endpoint.
- `apps/gateway/src/app.ts:251` defines the Codex Responses proxy endpoint.
