import { useState, useEffect, useCallback, useRef } from 'react';
import { Editor } from './components/Editor';
import { ResultPanel } from './components/ResultPanel';
import { EXAMPLES } from './examples';
import { evaluate, encodeState, decodeState, type EvalResult } from './engine';

export function App() {
  const [policy, setPolicy] = useState(EXAMPLES[0].policy);
  const [toolName, setToolName] = useState(EXAMPLES[0].toolName);
  const [args, setArgs] = useState(EXAMPLES[0].args);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [activeExample, setActiveExample] = useState(EXAMPLES[0].id);
  const [copied, setCopied] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load state from URL hash on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const state = decodeState(hash);
      if (state) {
        setPolicy(state.policy);
        setToolName(state.toolName);
        setArgs(state.args);
        setActiveExample('');
      }
    }
  }, []);

  const runEval = useCallback(async () => {
    if (!toolName.trim()) return;
    const evalResult = await evaluate(policy, toolName.trim(), args);
    setResult(evalResult);
  }, [policy, toolName, args]);

  // Auto-evaluate on changes (debounced)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (toolName.trim() && args.trim() && policy.trim()) {
        runEval();
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [policy, toolName, args, runEval]);

  // Ctrl+Enter shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runEval();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [runEval]);

  function loadExample(id: string) {
    const example = EXAMPLES.find((e) => e.id === id);
    if (!example) return;
    setPolicy(example.policy);
    setToolName(example.toolName);
    setArgs(example.args);
    setActiveExample(id);
    setResult(null);
  }

  function shareUrl() {
    const hash = encodeState({ policy, toolName, args });
    const url = `${window.location.origin}${window.location.pathname}#${hash}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied('link');
      setTimeout(() => setCopied(null), 2000);
    });
  }

  function copyPolicy() {
    navigator.clipboard.writeText(policy).then(() => {
      setCopied('policy');
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/80 backdrop-blur shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-tight">
            <span className="text-indigo-400">veto</span>
            <span className="text-gray-400 font-normal ml-1">playground</span>
          </h1>
          <span className="text-xs text-gray-600">|</span>
          <span className="text-xs text-gray-500">Test AI agent policies in real time</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyPolicy}
            className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
          >
            {copied === 'policy' ? 'Copied!' : 'Copy YAML'}
          </button>
          <button
            onClick={shareUrl}
            className="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition"
          >
            {copied === 'link' ? 'Copied!' : 'Share'}
          </button>
        </div>
      </header>

      {/* Example bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/50 shrink-0 overflow-x-auto">
        <span className="text-xs text-gray-500 shrink-0">Examples:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.id}
            onClick={() => loadExample(ex.id)}
            className={`text-xs px-3 py-1 rounded-full whitespace-nowrap transition ${
              activeExample === ex.id
                ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                : 'bg-gray-800/60 text-gray-400 border border-gray-700/50 hover:border-gray-600 hover:text-gray-300'
            }`}
          >
            {ex.name}
          </button>
        ))}
      </div>

      {/* Main panels */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Policy editor */}
        <div className="w-1/2 flex flex-col border-r border-gray-800">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900/50 shrink-0">
            <span className="text-xs font-medium text-gray-400">Policy (YAML)</span>
          </div>
          <div className="flex-1 min-h-0">
            <Editor value={policy} onChange={setPolicy} language="yaml" />
          </div>
        </div>

        {/* Right: Tool call + results */}
        <div className="w-1/2 flex flex-col">
          {/* Tool call input */}
          <div className="border-b border-gray-800 shrink-0">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
              <span className="text-xs font-medium text-gray-400">Tool Call</span>
              <button
                onClick={runEval}
                className="text-xs px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
              >
                Evaluate
              </button>
            </div>
            <div className="p-3 space-y-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Tool Name</label>
                <input
                  type="text"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-gray-200 focus:outline-none focus:border-indigo-500"
                  placeholder="transfer_funds"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Arguments (JSON)</label>
                <div className="h-32">
                  <Editor value={args} onChange={setArgs} language="json" />
                </div>
              </div>
            </div>
          </div>

          {/* Result */}
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="flex items-center px-3 py-1.5 border-b border-gray-800 bg-gray-900/50 shrink-0">
              <span className="text-xs font-medium text-gray-400">Result</span>
            </div>
            <ResultPanel result={result} />
          </div>
        </div>
      </div>
    </div>
  );
}
