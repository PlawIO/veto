import { useEffect, useRef, useCallback } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'yaml' | 'json';
}

export function Editor({ value, onChange, language }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const stableOnChange = useCallback((v: string) => onChangeRef.current(v), []);

  useEffect(() => {
    if (!containerRef.current) return;

    const langExtension = language === 'yaml' ? yaml() : json();

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        langExtension,
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            stableOnChange(update.state.doc.toString());
          }
        }),
        keymap.of([]),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language, stableOnChange]); // value intentionally excluded — only sync externally below

  // Update content when value changes externally (e.g., example switch)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="h-full overflow-hidden rounded" />;
}
