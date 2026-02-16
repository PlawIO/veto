"""
LangGraph + Veto — ToolNode Wrapper Example (Python)

This example shows how to add Veto guardrails to a raw LangGraph graph
by wrapping the ToolNode with Veto validation.

Setup:
    pip install veto-sdk langgraph langchain-openai
"""

import asyncio
from langgraph.graph import MessagesState, StateGraph, START, END
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from veto import Veto, VetoOptions
from veto.integrations.langchain import create_veto_tool_node


@tool
def web_search(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


@tool
def delete_file(path: str) -> str:
    """Delete a file from disk."""
    return f"Deleted {path}"


async def main():
    veto = await Veto.init(VetoOptions(api_key="your-key"))
    tools = [web_search, delete_file]

    model = ChatOpenAI(model="gpt-4o").bind_tools(tools)

    async def call_model(state: MessagesState):
        response = await model.ainvoke(state["messages"])
        return {"messages": [response]}

    # Wrap ToolNode with Veto validation
    tool_node = ToolNode(tools)
    veto_tool_node = create_veto_tool_node(
        veto,
        tool_node,
        on_deny=lambda name, args, reason: print(f"[Veto] Blocked {name}: {reason}"),
    )

    graph = StateGraph(MessagesState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", veto_tool_node)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition, ["tools", END])
    graph.add_edge("tools", "agent")
    compiled = graph.compile()

    result = await compiled.ainvoke(
        {"messages": [{"role": "user", "content": 'Search for "veto sdk"'}]}
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
