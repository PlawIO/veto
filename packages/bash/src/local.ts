import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Veto, type GuardContext, type GuardResult } from 'veto-sdk';
import { findVetoDir } from 'veto-sdk/config';
import { RuleLoader } from 'veto-sdk/rules';
import { parse as parseYaml } from 'yaml';
import type { LocalEvaluationInput, LocalProjectConfig } from './types.js';

interface LocalVetoConfigFile {
  mode?: 'strict' | 'log' | 'shadow';
  rules?: {
    directory?: string;
    recursive?: boolean;
  };
  approval?: {
    pollInterval?: number;
    timeout?: number;
  };
}

const SILENT_LOGGER = {
  debug: (_message: string, _context?: Record<string, unknown>) => {},
  info: (_message: string, _context?: Record<string, unknown>) => {},
  warn: (_message: string, _context?: Record<string, unknown>) => {},
  error: (_message: string, _context?: Record<string, unknown>, _error?: Error) => {},
};

const localVetoCache = new Map<string, Promise<Veto>>();

function loadLocalConfig(vetoDir: string): LocalProjectConfig {
  const configPath = join(vetoDir, 'veto.config.yaml');
  const raw = existsSync(configPath)
    ? parseYaml(readFileSync(configPath, 'utf-8')) as LocalVetoConfigFile
    : {};

  return {
    vetoDir,
    configPath,
    mode: raw.mode,
    rulesDir: resolve(vetoDir, raw.rules?.directory ?? './rules'),
    recursive: raw.rules?.recursive ?? true,
    approvalPollIntervalMs: raw.approval?.pollInterval,
    approvalTimeoutMs: raw.approval?.timeout,
  };
}

export function findLocalProject(startDir: string): LocalProjectConfig | null {
  const vetoDir = findVetoDir(startDir);
  if (!vetoDir) {
    return null;
  }
  return loadLocalConfig(vetoDir);
}

async function getLocalVeto(project: LocalProjectConfig): Promise<Veto> {
  const cached = localVetoCache.get(project.configPath);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const loader = new RuleLoader({ logger: SILENT_LOGGER });
    loader.setYamlParser(parseYaml);
    const loaded = loader.loadFromDirectory(project.rulesDir, project.recursive);

    return Veto.fromRules({
      rules: loaded.allRules,
      outputRules: loaded.allOutputRules,
      mode: project.mode,
      logLevel: 'silent',
      approval: {
        pollInterval: project.approvalPollIntervalMs,
        timeout: project.approvalTimeoutMs,
      },
    });
  })();

  localVetoCache.set(project.configPath, pending);

  try {
    return await pending;
  } catch (error) {
    localVetoCache.delete(project.configPath);
    throw error;
  }
}

export async function evaluateLocally(input: LocalEvaluationInput): Promise<GuardResult> {
  const veto = await getLocalVeto(input.project);
  const context: GuardContext = input.context;
  return veto.guard('bash', input.args, context);
}

export function clearLocalVetoCache(): void {
  localVetoCache.clear();
}
