/**
 * Optional OpenTelemetry integration.
 *
 * Uses dynamic import so @opentelemetry/api is a zero-cost optional peer dep.
 * If not installed, all functions return no-ops.
 */

export interface VetoTracer {
  startSpan(name: string): VetoSpan;
}

export interface VetoSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

// Canonical OTEL status codes (avoid importing from @opentelemetry/api directly)
export const SpanStatusCode = { OK: 1, ERROR: 2 } as const;

const noopSpan: VetoSpan = {
  setAttribute() {},
  setStatus() {},
  end() {},
};

const noopTracer: VetoTracer = {
  startSpan() { return noopSpan; },
};

/**
 * Attempt to load @opentelemetry/api. Returns a VetoTracer wrapping the real
 * tracer, or a no-op tracer if the package is not installed.
 *
 * Call once during Veto.init() and store the result.
 */
export async function tryLoadOtel(serviceName = 'veto-sdk'): Promise<VetoTracer> {
  try {
    // Dynamic import — works in Node.js 20+ ESM. Throws ERR_MODULE_NOT_FOUND if not installed.
    const api = await import('@opentelemetry/api');
    const tracer = api.trace.getTracer(serviceName);
    return {
      startSpan(name: string): VetoSpan {
        const span = tracer.startSpan(name);
        return {
          setAttribute(key, value) { span.setAttribute(key, value); },
          setStatus(status) { span.setStatus(status); },
          end() { span.end(); },
        };
      },
    };
  } catch {
     
    console.debug('veto: @opentelemetry/api not available, tracing disabled');
    return noopTracer;
  }
}
