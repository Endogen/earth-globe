from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "assets"
INDEX_FILE = BASE_DIR / "index.html"
POINTS_FILE = DATA_DIR / "points.json"


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
    description: str = "Persistent globe-based point editor built with FastAPI and MapLibre"
    map_style_url: str = "https://tiles.openfreemap.org/styles/liberty"
    custom_attribution: str = "<a href=\"https://openfreemap.org\" target=\"_blank\" rel=\"noreferrer\">OpenFreeMap</a> | <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noreferrer\">OpenStreetMap contributors</a>"
    default_point_color: str = "#ff8d57"
    view: ViewDefaults = ViewDefaults()
    rotation: RotationDefaults = RotationDefaults()


settings = AppSettings()
