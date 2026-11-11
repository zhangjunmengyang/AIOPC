"""Small path and URL guards shared by the OPC service."""

from __future__ import annotations

import ipaddress
import socket
from pathlib import Path
from urllib.parse import urlsplit


def inside(value: str | Path, base: Path, roots: list[Path]) -> Path | None:
    """Resolve ``value`` (relative to ``base``) and return it only if it stays under one of ``roots``."""
    path = Path(value).expanduser()
    path = (base / path).resolve() if not path.is_absolute() else path.resolve()
    return path if any(path.is_relative_to(root.resolve()) for root in roots) else None


def public_https_url(url: str) -> bool:
    """True for https URLs whose host resolves only to public addresses (no loopback, LAN or metadata)."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return False
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(parts.hostname, parts.port or 443)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(address.split("%")[0]).is_global for address in addresses)
