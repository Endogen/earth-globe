"""Build the equirectangular globe textures in assets/textures from public-domain sources.

Run with: uv run --with pillow python scripts/build_globe_textures.py

Sources (all public domain):
- NASA Blue Marble Next Generation, July 2004 (topography + bathymetry)
- NASA Black Marble 2016 night lights
- Natural Earth 1:50m land and lakes polygons
"""

import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "assets" / "textures"
CACHE_DIR = ROOT / ".texture-cache"
SOURCES = {
    "day": "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73751/world.topo.bathy.200407.3x5400x2700.jpg",
    "night": "https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg",
    "land": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson",
    "lakes": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson",
}
# Power-of-two sizes allow mipmapping on every WebGL implementation; 4096 is the portable texture limit.
COLOR_SIZE = (4096, 2048)
# Night lights also ship at 8192 px (about 5 km per texel) for GPUs that allow it; the source is 13500 px wide.
NIGHT_SIZES = {"earth-night.jpg": (4096, 2048), "earth-night-8k.jpg": (8192, 4096)}
MASK_SIZE = (2048, 1024)
# Black Marble renders unlit land and moonlit ice (up to ~52) as faint grey; below this luminance is not artificial light.
NIGHT_LIGHT_FLOOR = 54
# Lifts dim suburban light that the floor subtraction would otherwise flatten.
NIGHT_LIGHT_GAMMA = 0.8

Image.MAX_IMAGE_PIXELS = None


def fetch(name: str) -> Path:
    url = SOURCES[name]
    path = CACHE_DIR / Path(url).name
    if not path.exists():
        CACHE_DIR.mkdir(exist_ok=True)
        print(f"Downloading {url}", file=sys.stderr)
        with urllib.request.urlopen(url, timeout=120) as response:
            path.write_bytes(response.read())
    return path


def build_day() -> None:
    image = Image.open(fetch("day")).convert("RGB").resize(COLOR_SIZE, Image.Resampling.LANCZOS)
    image.save(OUTPUT_DIR / "earth-day.jpg", quality=86, optimize=True, progressive=True)


def build_night() -> None:
    luminance = Image.open(fetch("night")).convert("L")
    span = 255 - NIGHT_LIGHT_FLOOR
    for name, size in NIGHT_SIZES.items():
        resized = luminance.resize(size, Image.Resampling.LANCZOS)
        lights = resized.point(lambda value: round(255 * (max(0, value - NIGHT_LIGHT_FLOOR) / span) ** NIGHT_LIGHT_GAMMA))
        lights.save(OUTPUT_DIR / name, quality=88, optimize=True, progressive=True)


def polygon_rings(geometry: dict):
    polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    for polygon in polygons:
        yield polygon[0], polygon[1:]


def draw_features(draw: ImageDraw.ImageDraw, path: Path, fill: int, hole_fill: int, size: tuple[int, int]) -> None:
    width, height = size

    def project(ring):
        return [((longitude + 180) / 360 * width, (90 - latitude) / 180 * height) for longitude, latitude in ring]

    for feature in json.loads(path.read_text())["features"]:
        for outer, holes in polygon_rings(feature["geometry"]):
            draw.polygon(project(outer), fill=fill)
            for hole in holes:
                draw.polygon(project(hole), fill=hole_fill)


def build_water_mask() -> None:
    # Rasterize at 2x and downsample so coastlines get anti-aliased edges. White = water.
    size = (MASK_SIZE[0] * 2, MASK_SIZE[1] * 2)
    mask = Image.new("L", size, 255)
    draw = ImageDraw.Draw(mask)
    draw_features(draw, fetch("land"), fill=0, hole_fill=255, size=size)
    draw_features(draw, fetch("lakes"), fill=255, hole_fill=0, size=size)
    # Antarctic ice shelves and sea ice are not glossy water.
    draw.rectangle((0, round(size[1] * (1 - 12 / 180)), size[0], size[1]), fill=0)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2)).resize(MASK_SIZE, Image.Resampling.LANCZOS)
    ImageOps.autocontrast(mask).save(OUTPUT_DIR / "earth-water.png", optimize=True)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    build_day()
    build_night()
    build_water_mask()
    for path in sorted(OUTPUT_DIR.iterdir()):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
