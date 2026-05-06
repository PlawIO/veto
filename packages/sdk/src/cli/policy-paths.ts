import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function isPathInsideDirectory(parentDir: string, childPath: string): boolean {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function resolvePolicyRulesDirectory(options: {
  vetoDir: string;
  configuredDirectory?: string;
  requireExists?: boolean;
}): string {
  const vetoDir = resolve(options.vetoDir);
  const projectDir = dirname(vetoDir);
  const rulesDir = resolve(vetoDir, options.configuredDirectory ?? './rules');

  if (!isPathInsideDirectory(projectDir, rulesDir)) {
    throw new Error(`Rules directory must stay inside the project: ${rulesDir}`);
  }

  if (!options.requireExists) {
    return rulesDir;
  }

  if (!existsSync(rulesDir)) {
    throw new Error(`Rules directory does not exist: ${rulesDir}`);
  }

  const rulesStat = statSync(rulesDir);
  if (!rulesStat.isDirectory()) {
    throw new Error(`Rules path is not a directory: ${rulesDir}`);
  }

  const realProjectDir = realpathSync(projectDir);
  const realRulesDir = realpathSync(rulesDir);
  if (!isPathInsideDirectory(realProjectDir, realRulesDir)) {
    throw new Error(`Rules directory resolves outside the project: ${rulesDir}`);
  }

  return rulesDir;
}
