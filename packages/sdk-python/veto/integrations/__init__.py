"""
Veto integrations for third-party agent frameworks.

Each sub-module provides a ready-to-use wrapper for a specific framework,
so users only need to initialize Veto and call a single function to get
guardrail-protected tools.

Available integrations:
    - browser_use: AI browser automation with Veto guardrails.
    - langchain: LangChain middleware, callback handler, and LangGraph ToolNode wrapper.
"""
