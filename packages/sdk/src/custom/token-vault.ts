const SECRET_ENV_NAME_PATTERN = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|BEARER|ACCESS[_-]?KEY)/i;
const PLACEHOLDER_PREFIX = '__VETO_TOKEN_VAULT_';
const MIN_EXPLICIT_SECRET_LENGTH = 4;
const MIN_AUTO_SECRET_LENGTH = 8;

export interface TokenVaultEntry {
  envVarName: string;
  placeholder: string;
  value: string;
}

export interface TokenVault {
  entries: TokenVaultEntry[];
  redactText(text: string): string;
  restoreText(text: string): string;
  maskText(text: string): string;
}

export interface TokenVaultOptions {
  env?: Record<string, string | undefined>;
  envVarNames?: string[];
}

export function createEnvTokenVault(options: TokenVaultOptions = {}): TokenVault {
  const env = options.env ?? process.env;
  const envVarCandidates = collectEnvVarCandidates(env, options.envVarNames);
  const seenValues = new Set<string>();
  const entries: TokenVaultEntry[] = [];

  for (const { envVarName, explicit } of envVarCandidates) {
    const value = env[envVarName];
    const minLength = explicit ? MIN_EXPLICIT_SECRET_LENGTH : MIN_AUTO_SECRET_LENGTH;
    if (!isVaultableSecret(value, minLength) || seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    entries.push({
      envVarName,
      value,
      placeholder: `${PLACEHOLDER_PREFIX}${entries.length + 1}__`,
    });
  }

  entries.sort((a, b) => b.value.length - a.value.length);

  return {
    entries,
    redactText(text: string): string {
      return redactEntries(text, entries);
    },
    restoreText(text: string): string {
      return replaceEntries(text, entries, 'placeholder', 'value');
    },
    maskText(text: string): string {
      return maskEntries(text, entries);
    },
  };
}

export function maskVaultedResponse<T extends { reasoning?: string; matched_rules?: string[] }>(
  response: T,
  vault: TokenVault
): T {
  if (vault.entries.length === 0) {
    return response;
  }

  return {
    ...response,
    ...(typeof response.reasoning === 'string'
      ? { reasoning: vault.maskText(response.reasoning) }
      : {}),
    ...(Array.isArray(response.matched_rules)
      ? { matched_rules: response.matched_rules.map((rule) => vault.maskText(rule)) }
      : {}),
  };
}

interface EnvVarCandidate {
  envVarName: string;
  explicit: boolean;
}

function collectEnvVarCandidates(
  env: Record<string, string | undefined>,
  explicitEnvVarNames?: string[]
): EnvVarCandidate[] {
  const candidates = new Map<string, EnvVarCandidate>();

  for (const name of explicitEnvVarNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      candidates.set(trimmed, { envVarName: trimmed, explicit: true });
    }
  }

  for (const name of Object.keys(env)) {
    if (SECRET_ENV_NAME_PATTERN.test(name) && !candidates.has(name)) {
      candidates.set(name, { envVarName: name, explicit: false });
    }
  }

  return [...candidates.values()];
}

function isVaultableSecret(value: string | undefined, minLength: number): value is string {
  if (!value || value.length < minLength) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return !['true', 'false', 'none', 'null', 'undefined'].includes(normalized);
}

function redactEntries(text: string, entries: TokenVaultEntry[]): string {
  let result = text;
  for (const entry of entries) {
    for (const value of redactionForms(entry.value)) {
      result = result.replace(new RegExp(escapeRegExp(value), 'g'), entry.placeholder);
    }
  }
  return result;
}

function redactionForms(value: string): string[] {
  const forms = new Set([value]);
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped) {
    forms.add(jsonEscaped);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function replaceEntries(
  text: string,
  entries: TokenVaultEntry[],
  from: 'value' | 'placeholder',
  to: 'value' | 'placeholder'
): string {
  let result = text;
  for (const entry of entries) {
    result = result.replace(new RegExp(escapeRegExp(entry[from]), 'g'), () => entry[to]);
  }
  return result;
}

function maskEntries(text: string, entries: TokenVaultEntry[]): string {
  let result = text;
  for (const entry of entries) {
    result = result.replace(
      new RegExp(escapeRegExp(entry.placeholder), 'g'),
      `[REDACTED_ENV:${entry.envVarName}]`
    );
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
