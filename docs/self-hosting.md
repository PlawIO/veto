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

The compose file starts `ghcr.io/plawio/veto-server:latest` on `localhost:3001` with `SELF_HOSTED=true` and `STORAGE_DRIVER=sqlite`. The platform server contract for this local mode is unauthenticated/local-auth validation on loopback so reviewers can exercise `/v1/validate` without a Plaw account.

Customer-plane boundary: local policy, decision rows, tool arguments, agent IDs, user IDs, Slack content, prompts, environment variables, and secrets stay inside the self-hosted environment. Nothing is sent to Plaw unless the operator explicitly configures outbound license heartbeat or optional telemetry.
