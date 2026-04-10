"""CLI entrypoint for the Veto Python SDK."""

from __future__ import annotations

import argparse
import asyncio
import signal
import sys

from veto.proxy import ProxyConfig, start_proxy_server


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="veto")
    subparsers = parser.add_subparsers(dest="command")

    for name in ("proxy", "intercept"):
        cmd = subparsers.add_parser(name, help="Start the Veto SSE intercept proxy")
        cmd.add_argument("--port", type=int, default=8080)
        cmd.add_argument("--target", default="https://api.openai.com")
        cmd.add_argument("--config", default="./veto")
        cmd.add_argument("--max-buffer", type=int, default=1024 * 1024)
        cmd.add_argument("--format", choices=["auto", "openai", "anthropic"], default="auto")

    return parser


async def _run_proxy(args: argparse.Namespace) -> int:
    config = ProxyConfig(
        port=args.port,
        target=args.target,
        config_dir=args.config,
        max_buffer_bytes=args.max_buffer,
        format=args.format,
    )
    server = await start_proxy_server(config)
    print(f"veto proxy listening on {server.url} -> {config.target}")

    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            pass

    try:
        await stop_event.wait()
    finally:
        await server.stop()
    return 0


async def main_async(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command in {"proxy", "intercept"}:
        return await _run_proxy(args)

    parser.print_help()
    return 1


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(main_async(argv))


if __name__ == "__main__":
    sys.exit(main())
