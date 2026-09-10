from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


@dataclass
class Config:
    freshportal_url: str = field(
        default_factory=lambda: os.getenv("FRESHPORTAL_URL", "https://850255test.freshportal.com")
    )
    freshportal_username: str = field(
        default_factory=lambda: os.getenv("FRESHPORTAL_USERNAME", "")
    )
    freshportal_password: str = field(
        default_factory=lambda: os.getenv("FRESHPORTAL_PASSWORD", "")
    )
    anthropic_api_key: str = field(
        default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", "")
    )
    anthropic_model: str = field(
        default_factory=lambda: os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5")
    )
    floricode_username: str = field(
        default_factory=lambda: os.getenv("FLORICODE_USERNAME", "")
    )
    floricode_password: str = field(
        default_factory=lambda: os.getenv("FLORICODE_PASSWORD", "")
    )
    dfg_api_key: str = field(
        default_factory=lambda: os.getenv("DFG_API_KEY", "")
    )
    dfg_api_base_url: str = field(
        default_factory=lambda: os.getenv("DFG_API_BASE_URL", "https://850255-api.freshportal.com")
    )
    bi_sync_api_key: str = field(
        default_factory=lambda: os.getenv("BI_SYNC_API_KEY", "")
    )
    bi_sync_api_base_url: str = field(
        default_factory=lambda: os.getenv("BI_SYNC_API_BASE_URL", "https://850255-api.freshportal.com")
    )
    vbn_to_check: str = field(
        default_factory=lambda: os.getenv("VBN_TO_CHECK", "595")
    )
    page_size: int = 250
    request_timeout: int = 30_000  # ms for playwright
    retry_attempts: int = 3

    def validate(self) -> None:
        missing = []
        if not self.freshportal_username:
            missing.append("FRESHPORTAL_USERNAME")
        if not self.freshportal_password:
            missing.append("FRESHPORTAL_PASSWORD")
        if missing:
            raise ValueError(f"Missing required env vars: {', '.join(missing)}")


config = Config()

KENYA_FP_URL = os.getenv("KENYA_FP_URL", "https://850254.freshportal.nl")


def get_kenya_cfg() -> Config:
    """Config targeting the Kenya system (850254), for both its portal and
    its BI Sync export.

    Kenya is a separate FreshPortal tenant on its own API host with its own
    key, so the BI Sync fields are overridden too — not just the portal URL.
    Falls back to the main credentials where a Kenya-specific one isn't set,
    mirroring get_ecuador_cfg(). Lives here rather than in api_server.py so
    the Kenya module can import it without a circular import.
    """
    cfg = Config()
    cfg.freshportal_url = KENYA_FP_URL
    for env_name, attr in (
        ("KENYA_FP_USERNAME", "freshportal_username"),
        ("KENYA_FP_PASSWORD", "freshportal_password"),
        ("KENYA_BI_SYNC_API_KEY", "bi_sync_api_key"),
        ("KENYA_BI_SYNC_API_BASE_URL", "bi_sync_api_base_url"),
    ):
        value = os.getenv(env_name, "")
        if value:
            setattr(cfg, attr, value)
    return cfg


ALLOWED_FP_URLS: frozenset[str] = frozenset({
    "https://fp042100.freshportal.nl",
    "https://850295.freshportal.nl",
    "https://850255.freshportal.nl",
    "https://fp012603.freshportal.com",
    "https://850254.freshportal.nl",
    "https://fp066801.freshportal.com",
})
