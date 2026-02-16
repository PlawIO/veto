"""
LangChain + Veto — Agent Middleware Example (Python)

This example shows how to add Veto guardrails to a LangChain agent
using the v1 middleware system.

Setup:
    pip install veto-sdk langchain langchain-openai
"""

import asyncio
from langchain.agents import create_agent
from langchain_core.tools import tool
from veto import Veto, VetoOptions
from veto.integrations.langchain import VetoMiddleware


@tool
def web_search(query: str) -> str:
    """Search the web for information."""
    return f"Search results for: {query}"


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email to a recipient."""
    return f"Email sent to {to}"


async def main():
    veto = await Veto.init(VetoOptions(api_key="your-key"))

    agent = create_agent(
        model="openai:gpt-4o",
        tools=[web_search, send_email],
        middleware=[
            VetoMiddleware(
                veto,
                on_deny=lambda name, args, reason: print(f"[Veto] Blocked {name}: {reason}"),
            ),
        ],
        system_prompt="You are a helpful assistant.",
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "Search for weather in SF"}]}
    )
    print(result)


if __name__ == "__main__":
    asyncio.run(main())
