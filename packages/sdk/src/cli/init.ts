/**
 * veto init command implementation.
 *
 * @module cli/init
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createDefaultConfigTemplate,
  createGitignoreAdditions,
  DEFAULT_RULES,
  createPackRulesTemplate,
  ENV_EXAMPLE,
} from './templates.js';
import {
  normalizePolicyPackName,
  resolveBuiltInPolicyPackPath,
} from '../rules/policy-packs.js';

/**
 * Options for the init command.
 */
export interface InitOptions {
  /** Target directory (defaults to current working directory) */
  directory?: string;
  /** Force overwrite existing files */
  force?: boolean;
  /** Optional built-in policy pack to extend */
  pack?: string;
  /** Skip confirmation prompts */
  yes?: boolean;
  /** Suppress output */
  quiet?: boolean;
  /** Run in non-interactive agent mode */
  agent?: boolean;
  /** Validation mode selection */
  mode?: 'local' | 'api' | 'kernel' | 'custom';
  /** Configure generated config for cloud validation */
  cloud?: boolean;
  /** Write a cloud API key into the generated config */
  apiKey?: string;
  /** Enable human approval flow */
  approval?: boolean;
}

/**
 * Result of the init command.
 */
export interface InitResult {
  /** Whether initialization was successful */
  success: boolean;
  /** Path to the created veto directory */
  vetoDir: string;
  /** Files that were created */
  createdFiles: string[];
  /** Files that were skipped (already existed) */
  skippedFiles: string[];
  /** Any warnings or messages */
  messages: string[];
}

/**
 * Print a message to console (unless quiet mode).
 */
function log(message: string, quiet: boolean): void {
  if (!quiet) {
    console.log(message);
  }
}

/**
 * Initialize Veto in a project.
 *
 * Creates the following structure:
 * ```
 * veto/
 *   veto.config.yaml    # Main configuration file
 *   rules/
 *     defaults.yaml     # Default rules
 *   .env.example        # Example environment variables
 * ```
 *
 * @param options - Initialization options
 * @returns Result of the initialization
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const {
    directory = process.cwd(),
    force = false,
    pack,
    quiet = false,
    cloud = false,
    apiKey,
  } = options;

  const result: InitResult = {
    success: false,
    vetoDir: '',
    createdFiles: [],
    skippedFiles: [],
    messages: [],
  };

  const baseDir = resolve(directory);
  const vetoDir = join(baseDir, 'veto');
  const rulesDir = join(vetoDir, 'rules');
  const configTemplate = createDefaultConfigTemplate({
    validationMode: cloud ? 'api' : 'local',
    apiKey,
  });
  const gitignoreAdditions = createGitignoreAdditions(apiKey);
  let selectedPack: string | undefined;

  if (pack !== undefined) {
    if (pack.trim() === '') {
      result.messages.push('Invalid --pack value: expected a non-empty pack name.');
      log('  Invalid --pack value: expected a non-empty pack name.', quiet);
      return result;
    }

    try {
      selectedPack = normalizePolicyPackName(pack);
      resolveBuiltInPolicyPackPath(selectedPack);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.messages.push(message);
      log(`  ${message}`, quiet);
      return result;
    }
  }

  result.vetoDir = vetoDir;

  log('', quiet);
  log('Initializing Veto...', quiet);
  log('', quiet);

  // Check if veto directory already exists
  if (existsSync(vetoDir) && !force) {
    const configExists = existsSync(join(vetoDir, 'veto.config.yaml'));
    if (configExists) {
      result.messages.push(
        'Veto is already initialized in this directory. Use --force to overwrite.'
      );
      log('  Veto is already initialized in this directory.', quiet);
      log('  Use --force to overwrite existing files.', quiet);
      log('', quiet);
      return result;
    }
  }

  try {
    // Create veto directory
    if (!existsSync(vetoDir)) {
      mkdirSync(vetoDir, { recursive: true });
      log('  Created veto/', quiet);
    }

    // Create rules directory
    if (!existsSync(rulesDir)) {
      mkdirSync(rulesDir, { recursive: true });
      log('  Created veto/rules/', quiet);
    }

    // Create veto.config.yaml
    const configPath = join(vetoDir, 'veto.config.yaml');
    if (!existsSync(configPath) || force) {
      writeFileSync(configPath, configTemplate, 'utf-8');
      result.createdFiles.push('veto/veto.config.yaml');
      log('  Created veto/veto.config.yaml', quiet);
      if (apiKey) {
        const apiKeyWarning = 'Warning: API key written to veto/veto.config.yaml — do NOT commit this file, or set VETO_API_KEY env var instead.';
        result.messages.push(apiKeyWarning);
        log(apiKeyWarning, quiet);
      }
    } else {
      result.skippedFiles.push('veto/veto.config.yaml');
      log('  Skipped veto/veto.config.yaml (already exists)', quiet);
    }

    // Create rules/defaults.yaml
    const rulesPath = join(rulesDir, 'defaults.yaml');
    const rulesTemplate = selectedPack
      ? createPackRulesTemplate(selectedPack)
      : DEFAULT_RULES;
    if (!existsSync(rulesPath) || force) {
      writeFileSync(rulesPath, rulesTemplate, 'utf-8');
      result.createdFiles.push('veto/rules/defaults.yaml');
      log('  Created veto/rules/defaults.yaml', quiet);
    } else {
      result.skippedFiles.push('veto/rules/defaults.yaml');
      log('  Skipped veto/rules/defaults.yaml (already exists)', quiet);
    }

    // Create .env.example
    const envPath = join(vetoDir, '.env.example');
    if (!existsSync(envPath) || force) {
      writeFileSync(envPath, ENV_EXAMPLE, 'utf-8');
      result.createdFiles.push('veto/.env.example');
      log('  Created veto/.env.example', quiet);
    } else {
      result.skippedFiles.push('veto/.env.example');
      log('  Skipped veto/.env.example (already exists)', quiet);
    }

    // Update .gitignore if it exists
    const gitignorePath = join(baseDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
      const missingEntries = gitignoreAdditions
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && !entry.startsWith('#') && !gitignoreContent.includes(entry));

      if (missingEntries.length > 0) {
        const needsTrailingNewline = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n');
        const commentPrefix = gitignoreContent.includes('# Veto') ? '' : '# Veto\n';
        writeFileSync(
          gitignorePath,
          `${gitignoreContent}${needsTrailingNewline ? '\n' : ''}${commentPrefix}${missingEntries.join('\n')}\n`,
          'utf-8'
        );
        result.messages.push('Updated .gitignore with Veto entries');
        log('  Updated .gitignore', quiet);
      }
    }

    result.success = true;

    log('', quiet);
    log('Veto initialized successfully!', quiet);
    log('', quiet);
    log('Next steps:', quiet);
    if (selectedPack) {
      log(`  1. Customize inherited rules from ${selectedPack} in veto/rules/defaults.yaml`, quiet);
    } else {
      log('  1. Add your validation rules in veto/rules/', quiet);
    }
    log('  2. Use Veto in your application (local mode is default):', quiet);
    log('  3. Optional: set VETO_API_KEY to switch to cloud mode', quiet);
    log('', quiet);
    log('     import { protect } from "veto-sdk";', quiet);
    log('', quiet);
    log('     const safeTools = await protect(myTools);', quiet);
    log('', quiet);

  } catch (error) {
    result.success = false;
    const message = error instanceof Error ? error.message : String(error);
    result.messages.push(`Error: ${message}`);
    log(`  Error: ${message}`, quiet);
  }

  return result;
}

/**
 * Check if Veto is initialized in a directory.
 *
 * @param directory - Directory to check
 * @returns True if Veto is initialized
 */
export function isInitialized(directory: string = process.cwd()): boolean {
  const vetoDir = join(resolve(directory), 'veto');
  const configPath = join(vetoDir, 'veto.config.yaml');
  return existsSync(configPath);
}

/**
 * Get the Veto directory path for a project.
 *
 * @param directory - Project directory
 * @returns Path to veto directory, or null if not initialized
 */
export function getVetoDir(directory: string = process.cwd()): string | null {
  const vetoDir = join(resolve(directory), 'veto');
  if (existsSync(vetoDir)) {
    return vetoDir;
  }
  return null;
}
