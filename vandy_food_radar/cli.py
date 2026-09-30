"""Command-line entry point (design.md §8, T6.5).

Exposes two offline subcommands wired to the fixture adapters, the SQLite
repository, and the Haversine location provider so the pipeline runs with no
network:

* ``seed`` — load the corpus with dates retargeted onto the target day (so the
  web view is populated).
* ``run`` — run the live pipeline over the configured sources for the target
  window (idempotent upsert on re-run).

Both persist to the SQLite database at ``--db`` (default ``store.db``).
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime

from .config import Config
from .pipeline import run as run_pipeline
from .pipeline import seed_demo
from .providers.location import build_location_provider
from .sources import build_sources, default_fetcher
from .sources.base import Window
from .store import SqliteRepository

DEFAULT_DB_PATH = "store.db"


def build_parser() -> argparse.ArgumentParser:
    """Return the argument parser for the ``vandy_food_radar`` CLI."""

    parser = argparse.ArgumentParser(
        prog="vandy_food_radar",
        description="Discover, verify, and rank Vanderbilt free-food events.",
    )
    parser.add_argument(
        "--db",
        default=DEFAULT_DB_PATH,
        help=f"SQLite database path (default: {DEFAULT_DB_PATH}).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "seed",
        help="Load the fixture corpus with dates retargeted onto tomorrow.",
    )
    subparsers.add_parser(
        "run",
        help="Run the pipeline over the configured sources for the target day.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and dispatch to the selected subcommand."""

    parser = build_parser()
    args = parser.parse_args(argv)
    config = Config.from_env()
    repository = SqliteRepository(args.db)
    try:
        if args.command == "seed":
            report = seed_demo(repository=repository, config=config)
        else:
            fetcher = default_fetcher(config)
            sources = build_sources(config, fetcher)
            window = Window.from_config(config, today=datetime.now(tz=UTC).date())
            report = run_pipeline(
                window,
                repository=repository,
                sources=sources,
                location_provider=build_location_provider(config),
                config=config,
            )
    finally:
        repository.close()

    print(
        f"{args.command}: target {report.target_date} — "
        f"fetched {report.fetched}, merged {report.merged}, "
        f"scored {report.scored}, cancelled {report.cancelled}, "
        f"conflicts {report.conflicts}, history {report.history_entries} "
        f"(db: {args.db})"
    )
    return 0


__all__ = ["build_parser", "main"]
