#!/usr/bin/env node

async function main(): Promise<void> {
  const { runMcpProxyCliOrExit } = await import('veto-sdk/cli');
  await runMcpProxyCliOrExit();
}

void main();
