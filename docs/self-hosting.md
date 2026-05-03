# Self-hosting

```bash
docker compose up
```

Public reviewer validation path:

```bash
curl -s http://localhost:3001/v1/validate \
  -H 'content-type: application/json' \
  -d '{"toolName":"bash","arguments":{"command":"echo hello"}}'
```

The compose file starts `ghcr.io/plawio/veto-server:latest` with host `localhost:3001` mapped to the image's container port `8080`. It sets `PORT=8080`, `HOST=0.0.0.0`, `SELF_HOSTED=true`, `STORAGE_DRIVER=sqlite`, and `SQLITE_PATH=/var/lib/veto/veto.sqlite`. The platform server contract for this local mode is unauthenticated/local-auth validation on loopback so reviewers can exercise `/v1/validate` without a Plaw account.

Customer-plane boundary: local policy, decision rows, tool arguments, agent IDs, user IDs, Slack content, prompts, environment variables, and secrets stay inside the self-hosted environment. The public compose path sets `LICENSE_HEARTBEAT_DISABLED=true`, so nothing is sent to Plaw unless the operator explicitly enables outbound license heartbeat or optional telemetry.
