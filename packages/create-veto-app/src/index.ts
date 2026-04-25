import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { init } from 'veto-sdk/cli';
import {
  getBuiltInPolicyPackNames,
  normalizePolicyPackName,
  resolveBuiltInPolicyPackPath,
} from 'veto-sdk/rules';

export type CreateVetoAppTemplate = 'node-ts';

export interface ScaffoldCreateVetoAppOptions {
  projectDir: string;
  template?: CreateVetoAppTemplate;
  pack?: string;
  cloud?: boolean;
  apiKey?: string;
  noInstall?: boolean;
}

export interface ScaffoldCreateVetoAppResult {
  targetDir: string;
  projectName: string;
  template: CreateVetoAppTemplate;
  pack?: string;
  createdFiles: string[];
  nextSteps: string[];
}

interface FileTemplate {
  path: string;
  content: string;
}

const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

function normalizeTemplate(template: string | undefined): CreateVetoAppTemplate {
  const selectedTemplate = template ?? 'node-ts';
  if (selectedTemplate !== 'node-ts') {
    throw new Error(`Unsupported template "${selectedTemplate}". Supported templates: node-ts.`);
  }
  return selectedTemplate;
}

function normalizeOptionalPack(pack: string | undefined): string | undefined {
  if (!pack || pack === 'none' || pack === 'default') {
    return undefined;
  }

  const normalizedPack = normalizePolicyPackName(pack);
  resolveBuiltInPolicyPackPath(normalizedPack);
  return normalizedPack;
}

function trimEdgeHyphens(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === '-') {
    start += 1;
  }

  while (end > start && value[end - 1] === '-') {
    end -= 1;
  }

  return value.slice(start, end);
}

function toPackageName(projectName: string): string {
  const normalized = trimEdgeHyphens(
    projectName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
  );
  return normalized || 'veto-agent';
}

function createPackageJson(projectName: string): string {
  return `${JSON.stringify({
    name: toPackageName(projectName),
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'tsx src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js',
    },
    dependencies: {
      'veto-sdk': 'latest',
    },
    devDependencies: {
      '@types/node': '^20.10.0',
      tsx: '^4.7.0',
      typescript: '^5.3.0',
    },
    engines: {
      node: '>=18.0.0',
    },
  }, null, 2)}\n`;
}

function createReadme(projectName: string, pack: string | undefined): string {
  const packLine = pack
    ? `- Veto rules extend \`${pack}\`. Review and tune \`veto/rules/defaults.yaml\` for your system. Starter packs are guardrails, not compliance claims.`
    : '- Veto starts in local mode with default rules in `veto/rules/defaults.yaml`.';

  return `# ${projectName}

Minimal TypeScript app guarded by Veto.

## Next steps

\`\`\`bash
npm install
npm run dev
\`\`\`

Useful commands:

\`\`\`bash
npm run build
npm start
\`\`\`

Notes:

${packLine}
- Local mode needs no API key.
- To use Veto Cloud later, set \`VETO_API_KEY\` in \`.env\` or configure \`veto/veto.config.yaml\`.
- Do not commit secrets or local Veto config files that contain secrets.
`;
}

function createGitignore(hasInlineApiKey: boolean): string {
  const entries = [
    'node_modules',
    'dist',
    '.env',
    'veto/.env',
    'veto/*.local.yaml',
  ];

  if (hasInlineApiKey) {
    entries.push('veto/veto.config.yaml');
  }

  return `${entries.join('\n')}\n`;
}

function createEnvExample(): string {
  return `# Copy this file to .env for local development.
# Local Veto mode does not need an API key.

# Veto Cloud only:
# VETO_API_KEY=veto_...
`;
}

function createTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`;
}

function createSource(): string {
  return `import { ToolCallDeniedError, Veto } from 'veto-sdk';

interface ReadFileArgs {
  path: string;
}

const tools = [
  {
    name: 'read_file',
    description: 'Read a local text file preview',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    async handler(args: ReadFileArgs): Promise<{ path: string; preview: string }> {
      return {
        path: args.path,
        preview: 'Replace this handler with your real tool implementation.',
      };
    },
  },
];

async function main(): Promise<void> {
  const veto = await Veto.init();
  const [readFile] = veto.wrap(tools);

  try {
    const result = await readFile.handler({ path: './README.md' });
    console.log('Tool result:', result);

    const guard = await veto.guard('execute_command', { command: 'echo hello' });
    console.log('Guard decision:', guard.decision, guard.reason ?? 'allowed');
  } catch (error) {
    if (error instanceof ToolCallDeniedError) {
      console.error(\`Veto denied \${error.toolName}: \${error.message}\`);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;
}

function createNodeTsTemplates(projectName: string, pack: string | undefined, hasInlineApiKey: boolean): FileTemplate[] {
  return [
    { path: 'package.json', content: createPackageJson(projectName) },
    { path: 'README.md', content: createReadme(projectName, pack) },
    { path: '.gitignore', content: createGitignore(hasInlineApiKey) },
    { path: '.env.example', content: createEnvExample() },
    { path: 'tsconfig.json', content: createTsconfig() },
    { path: 'src/index.ts', content: createSource() },
  ];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function ensureTargetDirectory(targetDir: string): Promise<void> {
  if (await pathExists(targetDir)) {
    const targetStat = await stat(targetDir);
    if (!targetStat.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${targetDir}`);
    }

    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${targetDir}`);
    }
    return;
  }

  await mkdir(targetDir, { recursive: true });
}

async function writeTemplateFile(targetDir: string, template: FileTemplate): Promise<void> {
  const filePath = resolve(targetDir, template.path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, template.content, 'utf-8');
}

function createNextSteps(projectName: string): string[] {
  return [
    `cd ${projectName}`,
    'npm install',
    'npm run dev',
  ];
}

export function getPolicyPackChoices(): string[] {
  return ['none', 'default', ...getBuiltInPolicyPackNames()];
}

export async function scaffoldCreateVetoApp(
  options: ScaffoldCreateVetoAppOptions
): Promise<ScaffoldCreateVetoAppResult> {
  if (!options.projectDir || options.projectDir.trim() === '') {
    throw new Error('Project directory is required. Usage: create-veto-app <project-dir> --template node-ts --yes');
  }

  const template = normalizeTemplate(options.template);
  const targetDir = resolve(options.projectDir);
  const projectName = basename(targetDir) || 'veto-agent';
  const pack = normalizeOptionalPack(options.pack);
  const hasInlineApiKey = typeof options.apiKey === 'string' && options.apiKey.length > 0;
  const createdFiles: string[] = [];

  await ensureTargetDirectory(targetDir);

  const templates = createNodeTsTemplates(projectName, pack, hasInlineApiKey);
  for (const fileTemplate of templates) {
    await writeTemplateFile(targetDir, fileTemplate);
    createdFiles.push(fileTemplate.path);
  }

  const initResult = await init({
    directory: targetDir,
    pack,
    cloud: options.cloud,
    apiKey: options.apiKey,
    quiet: true,
  });

  if (!initResult.success) {
    throw new Error(initResult.messages.join('\n') || 'Failed to initialize Veto files.');
  }

  createdFiles.push(...initResult.createdFiles);

  for (const lockfile of LOCKFILES) {
    if (await pathExists(resolve(targetDir, lockfile))) {
      throw new Error(`Scaffold unexpectedly created lockfile: ${lockfile}`);
    }
  }

  if (await pathExists(resolve(targetDir, 'node_modules'))) {
    throw new Error('Scaffold unexpectedly created node_modules.');
  }

  const envExample = await readFile(resolve(targetDir, '.env.example'), 'utf-8');
  if (options.apiKey && envExample.includes(options.apiKey)) {
    throw new Error('Root .env.example must not contain API key values.');
  }

  return {
    targetDir,
    projectName,
    template,
    pack,
    createdFiles,
    nextSteps: createNextSteps(projectName),
  };
}
