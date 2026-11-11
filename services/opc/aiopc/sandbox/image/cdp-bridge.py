"""Publish Chromium's DevTools port on the container network so AIOPC can reach it.

Chromium only listens on 127.0.0.1 inside the container, which is what we want:
the port is reachable from the host through Docker's published port, which AIOPC
binds to the host's own loopback, and from nowhere else.
"""

import asyncio

CHROMIUM = ("127.0.0.1", 9222)
LISTEN = ("0.0.0.0", 9223)


async def copy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


async def bridge(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(*CHROMIUM)
    except OSError:
        writer.close()
        return
    await asyncio.gather(copy(reader, upstream_writer), copy(upstream_reader, writer), return_exceptions=True)


async def main() -> None:
    server = await asyncio.start_server(bridge, *LISTEN)
    async with server:
        await server.serve_forever()


asyncio.run(main())
