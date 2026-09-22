"""Shared setup, loaded before any test module in this directory.

The ordering matters. test_product_create.py is written to run as a standalone
script on a machine with nothing installed, so it installs a fake `db` into
sys.modules. dfg_api_client binds names out of `db` at import time, so a test
importing it *after* that stub is in place gets the stub and fails on an
import error that has nothing to do with what it is testing.

Importing the real module here pins it in sys.modules first, whichever order
pytest then collects the test files in.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    import dfg_api_client  # noqa: F401
except Exception:  # pragma: no cover - psycopg2 missing locally is fine
    pass
