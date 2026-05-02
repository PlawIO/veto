#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { evaluateRulesLocally } = await import(pathToFileURL(resolve(ROOT, 'packages/sdk/dist/rules/local-evaluator.js')).href);

const rules = [
  {
    id: 'bench-server-block-rm-rf',
    name: 'Benchmark server block rm -rf',
    enabled: true,
    severity: 'critical',
    action: 'block',
    tools: ['bash'],
    conditions: [{ field: 'arguments.command', operator: 'contains', value: 'rm -rf' }],
  },
];

const port = Number(process.env.PORT ?? 3001);
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/v1/validate') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const toolName = typeof parsed.toolName === 'string' ? parsed.toolName : 'unknown';
      const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};
      const result = evaluateRulesLocally(rules, toolName, { arguments: args });
      const decision = result.decision === 'deny' ? 'deny' : result.decision === 'require_approval' ? 'require_approval' : 'allow';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ decision, reason: result.reason, ruleId: result.ruleId }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[veto-benchmark] PDP fixture listening on http://127.0.0.1:${port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
