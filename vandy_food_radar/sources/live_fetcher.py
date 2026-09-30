"""Small stdlib HTTP client used by live source adapters."""

from __future__ import annotations

import urllib.error
import urllib.request

from .base import FetchResult


class UrllibHttpFetcher:
    """Retrieve public source URLs without raising network exceptions."""

    def __init__(self, *, user_agent: str = "VandyFoodRadar/1.0") -> None:
        self._user_agent = user_agent

    def get(self, url: str, *, timeout: float = 10.0) -> FetchResult:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": self._user_agent,
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                status = response.status
                return FetchResult(
                    url=url,
                    ok=200 <= status < 300,
                    status=status,
                    text=body,
                    error=None if 200 <= status < 300 else f"HTTP {status}",
                )
        except urllib.error.HTTPError as exc:
            return FetchResult(
                url=url,
                ok=False,
                status=exc.code,
                error=f"HTTP {exc.code}",
            )
        except (
            urllib.error.URLError,
            TimeoutError,
            UnicodeDecodeError,
            ValueError,
            OSError,
        ) as exc:
            return FetchResult(url=url, ok=False, error=str(exc))


__all__ = ["UrllibHttpFetcher"]
