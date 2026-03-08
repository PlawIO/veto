import type { EvalResult } from '../engine';

interface ResultPanelProps {
  result: EvalResult | null;
}

const DECISION_CONFIG = {
  allow: {
    label: 'Allowed',
    sublabel: 'Tool call passed all rules',
    bg: 'bg-emerald-500/10',
    ring: 'ring-emerald-500/20',
    accent: 'text-emerald-400',
    iconBg: 'bg-emerald-500/20',
    pillBg: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
      </svg>
    ),
  },
  deny: {
    label: 'Blocked',
    sublabel: 'Tool call was denied by policy',
    bg: 'bg-red-500/10',
    ring: 'ring-red-500/20',
    accent: 'text-red-400',
    iconBg: 'bg-red-500/20',
    pillBg: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
      </svg>
    ),
  },
  require_approval: {
    label: 'Needs Approval',
    sublabel: 'Tool call requires human review',
    bg: 'bg-amber-500/10',
    ring: 'ring-amber-500/20',
    accent: 'text-amber-400',
    iconBg: 'bg-amber-500/20',
    pillBg: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
    ),
  },
};

export function ResultPanel({ result }: ResultPanelProps) {
  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2">
        <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
        </svg>
        <span className="text-sm">Press <kbd className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 text-xs font-mono">Ctrl+Enter</kbd> to evaluate</span>
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="p-4">
        <div className="bg-red-500/10 ring-1 ring-red-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-400 font-semibold text-sm mb-2">
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            Parse Error
          </div>
          <pre className="text-red-300/80 text-sm font-mono whitespace-pre-wrap leading-relaxed">{result.error}</pre>
        </div>
      </div>
    );
  }

  const config = DECISION_CONFIG[result.decision];
  const matchedCount = result.trace.filter((t) => t.matched).length;

  return (
    <div className="p-4 space-y-5 overflow-auto h-full">
      {/* Decision card */}
      <div className={`${config.bg} ring-1 ${config.ring} rounded-xl p-5`}>
        <div className="flex items-start gap-4">
          <div className={`${config.iconBg} ${config.accent} rounded-lg p-2.5 shrink-0`}>
            {config.icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <span className={`font-semibold text-xl ${config.accent}`}>{config.label}</span>
              {result.severity && (
                <span className={`text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full ${config.pillBg}`}>
                  {result.severity}
                </span>
              )}
            </div>
            <div className="text-gray-400 text-sm mt-0.5">
              {result.reason || config.sublabel}
            </div>

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
              {result.ruleId && (
                <span className="text-xs text-gray-500">
                  Rule <code className="text-gray-300 bg-gray-800/60 px-1.5 py-0.5 rounded">{result.ruleId}</code>
                </span>
              )}
              {result.ruleName && (
                <span className="text-xs text-gray-500">
                  <code className="text-gray-300">{result.ruleName}</code>
                </span>
              )}
              <span className="text-xs text-gray-600">
                {result.latencyMs}ms
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Evaluation trace */}
      {result.trace.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Rule Evaluation
            </span>
            <span className="text-xs text-gray-600">
              {matchedCount}/{result.trace.length} matched
            </span>
          </div>
          <div className="space-y-1.5">
            {result.trace.map((entry) => {
              const actionColor =
                entry.action === 'block' ? 'text-red-400' :
                entry.action === 'require_approval' ? 'text-amber-400' :
                'text-emerald-400';
              const actionBg =
                entry.action === 'block' ? 'bg-red-500/10 ring-red-500/20' :
                entry.action === 'require_approval' ? 'bg-amber-500/10 ring-amber-500/20' :
                'bg-emerald-500/10 ring-emerald-500/20';

              return (
                <div
                  key={entry.ruleId}
                  className={`text-sm px-3 py-2.5 rounded-lg transition-colors ${
                    entry.matched
                      ? `${actionBg} ring-1`
                      : 'bg-gray-800/40 opacity-50'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {/* Status indicator */}
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      entry.matched ? actionColor.replace('text-', 'bg-') : 'bg-gray-600'
                    }`} />

                    {/* Rule name */}
                    <span className={`font-medium ${entry.matched ? 'text-gray-200' : 'text-gray-500'}`}>
                      {entry.ruleName}
                    </span>

                    {/* Action pill */}
                    <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      entry.matched
                        ? `${actionBg} ${actionColor} ring-1`
                        : 'bg-gray-800 text-gray-500'
                    }`}>
                      {entry.action}
                    </span>

                    {/* Match status */}
                    <span className={`text-xs ml-auto ${entry.matched ? actionColor : 'text-gray-600'}`}>
                      {entry.matched ? 'matched' : 'skipped'}
                    </span>
                  </div>

                  {/* Conditions detail */}
                  {entry.matched && entry.conditions && entry.conditions.length > 0 && (
                    <div className="ml-4 mt-2 space-y-0.5">
                      {entry.conditions.map((c, i) => (
                        <div key={i} className="text-xs font-mono text-gray-400 flex items-center gap-1.5">
                          <span className="text-gray-500">{c.field}</span>
                          <span className={actionColor}>{c.operator}</span>
                          <span className="text-gray-300">{JSON.stringify(c.value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
