import type { EvalResult } from '../engine';

interface ResultPanelProps {
  result: EvalResult | null;
}

const DECISION_STYLES = {
  allow: { bg: 'bg-green-900/30', border: 'border-green-500/50', text: 'text-green-400', icon: '\u2713', label: 'ALLOWED' },
  deny: { bg: 'bg-red-900/30', border: 'border-red-500/50', text: 'text-red-400', icon: '\u2717', label: 'DENIED' },
  require_approval: { bg: 'bg-amber-900/30', border: 'border-amber-500/50', text: 'text-amber-400', icon: '\u23f3', label: 'REQUIRES APPROVAL' },
};

export function ResultPanel({ result }: ResultPanelProps) {
  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Click "Evaluate" or press Ctrl+Enter to test
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="p-4">
        <div className="bg-red-900/30 border border-red-500/50 rounded-lg p-4">
          <div className="text-red-400 font-semibold text-sm mb-1">Error</div>
          <div className="text-red-300 text-sm font-mono">{result.error}</div>
        </div>
      </div>
    );
  }

  const style = DECISION_STYLES[result.decision];

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      {/* Decision badge */}
      <div className={`${style.bg} border ${style.border} rounded-lg p-4`}>
        <div className="flex items-center gap-3">
          <span className={`text-3xl ${style.text}`}>{style.icon}</span>
          <div>
            <div className={`font-bold text-lg ${style.text}`}>{style.label}</div>
            {result.reason && (
              <div className="text-gray-300 text-sm mt-1">{result.reason}</div>
            )}
          </div>
        </div>
        <div className="flex gap-4 mt-3 text-xs text-gray-400">
          {result.ruleId && <span>Rule: <code className="text-gray-300">{result.ruleId}</code></span>}
          {result.ruleName && <span>Name: <code className="text-gray-300">{result.ruleName}</code></span>}
          {result.severity && <span>Severity: <code className="text-gray-300">{result.severity}</code></span>}
          <span>Latency: <code className="text-gray-300">{result.latencyMs}ms</code></span>
        </div>
      </div>

      {/* Evaluation trace */}
      {result.trace.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Evaluation Trace
          </div>
          <div className="space-y-1">
            {result.trace.map((entry) => (
              <div
                key={entry.ruleId}
                className={`text-sm font-mono px-3 py-2 rounded border ${
                  entry.matched
                    ? entry.action === 'block'
                      ? 'border-red-500/30 bg-red-900/10'
                      : entry.action === 'require_approval'
                        ? 'border-amber-500/30 bg-amber-900/10'
                        : 'border-green-500/30 bg-green-900/10'
                    : 'border-gray-700/50 bg-gray-800/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={entry.matched ? 'text-white' : 'text-gray-500'}>
                    {entry.matched ? '\u25cf' : '\u25cb'}
                  </span>
                  <span className={entry.matched ? 'text-gray-200' : 'text-gray-500'}>
                    {entry.ruleName}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    entry.action === 'block' ? 'bg-red-900/40 text-red-400' :
                    entry.action === 'require_approval' ? 'bg-amber-900/40 text-amber-400' :
                    entry.action === 'allow' ? 'bg-green-900/40 text-green-400' :
                    'bg-gray-700 text-gray-400'
                  }`}>
                    {entry.action}
                  </span>
                  <span className="text-gray-600 text-xs ml-auto">
                    {entry.matched ? 'matched' : 'skipped'}
                  </span>
                </div>
                {entry.matched && entry.conditions && entry.conditions.length > 0 && (
                  <div className="ml-5 mt-1 text-xs text-gray-400">
                    {entry.conditions.map((c, i) => (
                      <div key={i}>
                        {c.field} {c.operator} {JSON.stringify(c.value)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
