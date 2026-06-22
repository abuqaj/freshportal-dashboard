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

ALLOWED_FP_URLS: frozenset[str] = frozenset({
    "https://fp042100.freshportal.nl",
    "https://850295.freshportal.nl",
    "https://850255.freshportal.nl",
    "https://fp012603.freshportal.com",
    "https://850254.freshportal.nl",
    "https://fp066801.freshportal.com",
})
