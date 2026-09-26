from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from filelock import FileLock


BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "assets"
INDEX_FILE = BASE_DIR / "index.html"
POINTS_FILE = DATA_DIR / "points.json"
TRACKING_DATABASE_FILE = DATA_DIR / "tracking.sqlite3"
TRACKING_ADMIN_TOKEN_FILE = DATA_DIR / "tracking-admin-token.txt"
DOWNLOADS_DIR = BASE_DIR / "downloads"


def get_or_create_tracking_admin_token() -> str:
    configured_token = os.environ.get("EARTH_GLOBE_ADMIN_TOKEN", "").strip()
    if configured_token:
        if len(configured_token) < 24:
            raise RuntimeError("EARTH_GLOBE_ADMIN_TOKEN must contain at least 24 characters.")
        return configured_token

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with FileLock(str(TRACKING_ADMIN_TOKEN_FILE) + ".lock"):
        if TRACKING_ADMIN_TOKEN_FILE.exists():
            token = TRACKING_ADMIN_TOKEN_FILE.read_text(encoding="utf-8").strip()
            if len(token) < 24:
                raise RuntimeError("The saved control key is invalid. Restore it or set EARTH_GLOBE_ADMIN_TOKEN.")
            TRACKING_ADMIN_TOKEN_FILE.chmod(0o600)
            return token

        token = secrets.token_urlsafe(32)
        descriptor = os.open(TRACKING_ADMIN_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as token_file:
            token_file.write(f"{token}\n")
            token_file.flush()
            os.fsync(token_file.fileno())
        return token


@dataclass(frozen=True, slots=True)
class ViewDefaults:
    longitude: float = 9.5
    latitude: float = 18.0
    zoom: float = 1.6
    bearing: float = 0.0
    pitch: float = 0.0
    min_zoom: float = 1.1
    max_zoom: float = 17.0


@dataclass(frozen=True, slots=True)
class RotationDefaults:
    enabled: bool = True
    degrees_per_second: float = 2.8
    max_zoom: float = 3.4


@dataclass(frozen=True, slots=True)
class AppSettings:
    title: str = "Earth Marker Studio"
    description: str = "Private globe workspace with saved points and on-demand Android device tracking"
    map_style_url: str = "https://tiles.openfreemap.org/styles/liberty"
    # The selected style supplies OpenFreeMap / OpenStreetMap attribution; this credits the globe textures.
    custom_attribution: str = "Imagery: NASA Blue Marble and Black Marble"
    default_point_color: str = "#ff8d57"
    view: ViewDefaults = ViewDefaults()
    rotation: RotationDefaults = RotationDefaults()


settings = AppSettings()
