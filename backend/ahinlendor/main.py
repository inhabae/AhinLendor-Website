"""ASGI entry point used by Uvicorn and the production container."""

from .api import app

__all__ = ["app"]
