"""Tests for OpenTelemetry integration."""

from veto.observability.otel import (
    try_load_otel,
    _NoopTracer,
    _NoopSpan,
    SPAN_STATUS_OK,
    SPAN_STATUS_ERROR,
)


class TestTryLoadOtel:
    def test_returns_noop_when_otel_not_installed(self):
        tracer = try_load_otel()
        # Should return a working tracer (noop) without raising
        span = tracer.start_span("test")
        span.set_attribute("key", "value")
        span.set_status(SPAN_STATUS_OK)
        span.end()

    def test_noop_span_accepts_all_types(self):
        span = _NoopSpan()
        span.set_attribute("str", "value")
        span.set_attribute("int", 42)
        span.set_attribute("bool", True)
        span.set_status(SPAN_STATUS_ERROR, "fail")
        span.end()

    def test_noop_tracer_returns_span(self):
        tracer = _NoopTracer()
        span = tracer.start_span("op")
        assert span is not None
