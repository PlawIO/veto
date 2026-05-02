async function loadVeto() {
  try {
    return await import('veto-sdk');
  } catch (error) {
    return await import('../../packages/sdk/dist/index.js');
  }
}

const { protect, ToolCallDeniedError } = await loadVeto();

const tools = [
  {
    name: 'bash',
    description: 'Run a shell command',
    async handler(args) {
      return `would execute: ${args.command}`;
    },
  },
];

const [bash] = await protect(tools);

try {
  await bash.handler({ command: 'rm -rf /tmp/veto-demo' });
  console.log('unexpected allow');
  process.exitCode = 1;
} catch (error) {
  if (error instanceof ToolCallDeniedError) {
    console.log(`denied: ${error.toolName} — ${error.message}`);
  } else {
    throw error;
  }
}
