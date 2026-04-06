"""
Optional OpenTelemetry integration.

Uses dynamic import so opentelemetry-api is a zero-cost optional dep.
If not installed, all functions return no-ops.
"""

from typing import Protocol, Union


class VetoSpan(Protocol):
    def set_attribute(self, key: str, value: Union[str, int, bool]) -> None: ...
    def set_status(self, status_code: int, message: str = "") -> None: ...
    def end(self) -> None: ...


class VetoTracer(Protocol):
    def start_span(self, name: str) -> VetoSpan: ...


SPAN_STATUS_OK = 1
SPAN_STATUS_ERROR = 2


class _NoopSpan:
    def set_attribute(self, key: str, value: Union[str, int, bool]) -> None:
        pass

    def set_status(self, status_code: int, message: str = "") -> None:
        pass

    def end(self) -> None:
        pass


class _NoopTracer:
    def start_span(self, name: str) -> VetoSpan:
        return _NoopSpan()


def try_load_otel(service_name: str = "veto-sdk") -> VetoTracer:
    """Load opentelemetry.api if installed, else return noop tracer."""
    try:
        from opentelemetry import trace

        tracer = trace.get_tracer(service_name)

        class _OtelSpan:
            def __init__(self, span: trace.Span) -> None:
                self._span = span

            def set_attribute(self, key: str, value: Union[str, int, bool]) -> None:
                self._span.set_attribute(key, value)

            def set_status(self, status_code: int, message: str = "") -> None:
                from opentelemetry.trace import StatusCode, Status

                sc = StatusCode.OK if status_code == SPAN_STATUS_OK else StatusCode.ERROR
                self._span.set_status(Status(sc, message))

            def end(self) -> None:
                self._span.end()

        class _OtelTracer:
            def start_span(self, name: str) -> VetoSpan:
                return _OtelSpan(tracer.start_span(name))

        return _OtelTracer()
    except ImportError:
        return _NoopTracer()
