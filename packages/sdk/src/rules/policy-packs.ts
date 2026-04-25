import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const BUILT_IN_POLICY_PACK_FILE_NAMES = {
  '@veto/coding-agent': 'coding-agent.yaml',
  '@veto/crypto-trading': 'crypto-trading.yaml',
  '@veto/financial': 'financial.yaml',
  '@veto/browser-automation': 'browser-automation.yaml',
  '@veto/data-access': 'data-access.yaml',
  '@veto/communication': 'communication.yaml',
  '@veto/deployment': 'deployment.yaml',
  '@veto/economic-agent': 'economic-agent.yaml',
  '@veto/soc2-lite': 'soc2-lite.yaml',
  '@veto/hipaa-lite': 'hipaa-lite.yaml',
  '@veto/eu-ai-act-starter': 'eu-ai-act-starter.yaml',
} as const;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = resolve(MODULE_DIR, '..', '..', 'packs');

type PolicyDocument = Record<string, unknown>;

export function getBuiltInPolicyPackNames(): string[] {
  return Object.keys(BUILT_IN_POLICY_PACK_FILE_NAMES);
}

export function normalizePolicyPackName(packName: string): string {
  const trimmed = packName.trim();
  if (trimmed.startsWith('@veto/')) {
    return trimmed;
  }
  return `@veto/${trimmed}`;
}

export function resolveBuiltInPolicyPackPath(packName: string): string {
  const normalizedName = normalizePolicyPackName(packName);
  const fileName = BUILT_IN_POLICY_PACK_FILE_NAMES[
    normalizedName as keyof typeof BUILT_IN_POLICY_PACK_FILE_NAMES
  ];

  if (!fileName) {
    throw new Error(
      `Unknown policy pack "${packName}". Available packs: ${getBuiltInPolicyPackNames().join(', ')}`
    );
  }

  const packPath = resolve(PACKS_DIR, fileName);
  if (!existsSync(packPath)) {
    throw new Error(
      `Policy pack "${normalizedName}" is bundled but missing at ${packPath}`
    );
  }

  return packPath;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value;
}

function getRuleId(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return undefined;
  }
  const id = (rule as PolicyDocument).id;
  return typeof id === 'string' ? id : undefined;
}

function mergeRulesById(
  baseRules: unknown[],
  userRules: unknown[]
): unknown[] {
  const mergedRules = [...baseRules];
  const idToIndex = new Map<string, number>();

  for (const [index, rule] of mergedRules.entries()) {
    const ruleId = getRuleId(rule);
    if (ruleId && !idToIndex.has(ruleId)) {
      idToIndex.set(ruleId, index);
    }
  }

  for (const userRule of userRules) {
    const ruleId = getRuleId(userRule);
    if (ruleId && idToIndex.has(ruleId)) {
      mergedRules[idToIndex.get(ruleId)!] = userRule;
      continue;
    }

    mergedRules.push(userRule);
    if (ruleId) {
      idToIndex.set(ruleId, mergedRules.length - 1);
    }
  }

  return mergedRules;
}

export function mergePolicyWithPack(
  packPolicy: PolicyDocument,
  userPolicy: PolicyDocument
): PolicyDocument {
  const mergedPolicy: PolicyDocument = {
    ...packPolicy,
    ...userPolicy,
  };

  if (packPolicy.rules !== undefined || userPolicy.rules !== undefined) {
    mergedPolicy.rules = mergeRulesById(
      asArray(packPolicy.rules),
      asArray(userPolicy.rules)
    );
  }

  if (packPolicy.output_rules !== undefined || userPolicy.output_rules !== undefined) {
    mergedPolicy.output_rules = mergeRulesById(
      asArray(packPolicy.output_rules),
      asArray(userPolicy.output_rules)
    );
  }

  return mergedPolicy;
}

export function resolvePolicyPackExtends(
  policyData: PolicyDocument,
  source: string,
  yamlParser?: (content: string) => unknown
): PolicyDocument {
  if (policyData.extends === undefined) {
    return policyData;
  }

  if (typeof policyData.extends !== 'string' || policyData.extends.trim() === '') {
    throw new Error(
      `Invalid "extends" value in ${source}. Expected a non-empty string like "@veto/coding-agent".`
    );
  }

  const normalizedPackName = normalizePolicyPackName(policyData.extends);
  const packPath = resolveBuiltInPolicyPackPath(normalizedPackName);
  const packContent = readFileSync(packPath, 'utf-8');
  const parser = yamlParser ?? parseYaml;
  const parsedPack = parser(packContent);

  if (!parsedPack || typeof parsedPack !== 'object' || Array.isArray(parsedPack)) {
    throw new Error(`Policy pack "${normalizedPackName}" at ${packPath} is not a valid YAML object`);
  }

  return mergePolicyWithPack(
    parsedPack as PolicyDocument,
    { ...policyData, extends: normalizedPackName }
  );
}
