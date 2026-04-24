"""Entrypoint for the host-side Codex CLI bridge service."""

from app.services.codex55_bridge import main

if __name__ == "__main__":
    raise SystemExit(main())
