interface ToolPackHeuristic {
  patterns: readonly string[];
  pack: string;
}

const TOOL_PACK_HEURISTICS: readonly ToolPackHeuristic[] = [
  {
    patterns: [
      'transfer',
      'payment',
      'balance',
      'withdraw',
      'deposit',
      'invoice',
      'refund',
      'charge',
      'payout',
      'wire',
      'bank',
      'fund',
      'money',
      'wallet',
    ],
    pack: '@veto/financial',
  },
  {
    patterns: [
      'navigate',
      'click',
      'goto',
      'browse',
      'scroll',
      'type_text',
      'fill_form',
      'screenshot',
      'open_url',
      'submit_form',
      'page',
      'tab',
      'browser',
    ],
    pack: '@veto/browser-automation',
  },
  {
    patterns: [
      'query',
      'sql',
      'database',
      'select',
      'insert',
      'table',
      'fetch_record',
      'read_record',
      'db',
      'collection',
      'document',
      'find',
      'aggregate',
    ],
    pack: '@veto/data-access',
  },
  {
    patterns: [
      'exec',
      'shell',
      'command',
      'terminal',
      'bash',
      'run_code',
      'write_file',
      'edit_file',
      'read_file',
      'delete_file',
      'mkdir',
      'code',
      'script',
    ],
    pack: '@veto/coding-agent',
  },
  {
    patterns: [
      'email',
      'send_email',
      'send_message',
      'notify',
      'sms',
      'slack',
      'message',
      'mail',
      'notification',
      'chat',
      'reply',
    ],
    pack: '@veto/communication',
  },
  {
    patterns: [
      'deploy',
      'publish',
      'release',
      'push',
      'rollback',
      'provision',
      'terraform',
      'kubernetes',
      'k8s',
      'docker',
      'helm',
      'ci_cd',
    ],
    pack: '@veto/deployment',
  },
];

export function collectHeuristicPacksForToolNames(
  toolNames: readonly string[]
): string[] {
  const packs = new Set<string>();

  for (const toolName of toolNames) {
    const normalized = toolName.toLowerCase();

    for (const heuristic of TOOL_PACK_HEURISTICS) {
      if (heuristic.patterns.some((pattern) => normalized.includes(pattern))) {
        packs.add(heuristic.pack);
      }
    }
  }

  return [...packs].sort((a, b) => a.localeCompare(b));
}

export function collectHeuristicPacksForSingleTool(toolName: string): string[] {
  return collectHeuristicPacksForToolNames([toolName]);
}

