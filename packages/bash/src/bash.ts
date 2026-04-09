import { existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ExecutionResult } from './types.js';

const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function resolveRealBashPath(options: { env: NodeJS.ProcessEnv; currentScriptPath: string }): string {
  const currentScriptRealpath = tryRealpath(options.currentScriptPath);
  const override = options.env.VETO_BASH_REAL_BASH?.trim();

  if (override) {
    if (!existsSync(override)) {
      throw new Error(`VETO_BASH_REAL_BASH does not exist: ${override}`);
    }

    const overrideRealpath = tryRealpath(override);
    if (currentScriptRealpath && overrideRealpath && currentScriptRealpath === overrideRealpath) {
      throw new Error(`Refusing to exec veto-bash recursively via ${override}. Set VETO_BASH_REAL_BASH to the real system bash.`);
    }

    return override;
  }

  const candidates = ['/bin/bash', '/usr/bin/bash'];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const candidateRealpath = tryRealpath(candidate);
    if (currentScriptRealpath && candidateRealpath && currentScriptRealpath === candidateRealpath) {
      throw new Error(`Refusing to exec veto-bash recursively via ${candidate}. Set VETO_BASH_REAL_BASH to the real system bash.`);
    }

    return candidate;
  }

  throw new Error('Unable to locate a real bash binary. Set VETO_BASH_REAL_BASH to /bin/bash or /usr/bin/bash.');
}

export async function executeRealBash(
  realBashPath: string,
  bashArgv: string[],
  stdinText?: string
): Promise<ExecutionResult> {
  return new Promise<ExecutionResult>((resolve, reject) => {
    const child = spawn(realBashPath, bashArgv, {
      stdio: stdinText === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      env: process.env,
    });

    const cleanupCallbacks: Array<() => void> = [];
    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        if (!child.killed) {
          child.kill(signal);
        }
      };
      process.on(signal, handler);
      cleanupCallbacks.push(() => process.off(signal, handler));
    }

    const cleanup = (): void => {
      for (const callback of cleanupCallbacks) {
        callback();
      }
    };

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('exit', (exitCode, signal) => {
      cleanup();
      resolve({
        exitCode,
        signal,
      });
    });

    if (stdinText !== undefined && child.stdin) {
      child.stdin.end(stdinText);
    }
  });
}
