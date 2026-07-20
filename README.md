# Earth Marker Studio

Professional globe-based point editor with:

- Python backend using FastAPI
- MapLibre GL JS front end with globe projection
- OSM-derived vector map styling via OpenFreeMap
- persisted point storage in `data/points.json`
- add, edit, move, and remove point workflows from both the map and the side panel
- modular frontend and backend code instead of a single browser script
- atomic JSON persistence and validated API payloads
- responsive desktop/mobile controls with reduced-motion support
- Python API tests and JavaScript utility tests

## Stack

- Backend: FastAPI + Uvicorn
- Frontend: MapLibre GL JS, modular ES modules, custom CSS
- Storage: local JSON repository
- Map style: `https://tiles.openfreemap.org/styles/liberty`

## Project layout

```text
.
├── assets/
│   ├── js/
│   └── styles/
├── data/
│   └── points.json
├── src/
│   └── earth_globe_demo/
├── tests/
│   ├── js/
│   └── test_*.py
├── index.html
├── package.json
├── pyproject.toml
├── uv.lock
└── README.md
```

## Run locally

Install the locked Python dependencies, including the development tools:

```bash
cd earth-globe
uv sync --dev
```

Start the app:

```bash
uv run uvicorn earth_globe_demo.main:app --reload --host 127.0.0.1 --port 8132
```

Then open `http://127.0.0.1:8132`.

To expose the app beyond your machine, choose the host and network controls deliberately; the default command binds only to localhost.

## Quality checks

```bash
uv run ruff check src tests
uv run pytest
npm test
```

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/points`
- `DELETE /api/points`
- `POST /api/points`
- `PUT /api/points/{point_id}`
- `DELETE /api/points/{point_id}`

Example create request:

```bash
curl -X POST http://127.0.0.1:8132/api/points \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "Operations Hub",
    "latitude": 37.7749,
    "longitude": -122.4194,
    "color": "#ff8d57"
  }'
```

Example update request:

```bash
curl -X PUT http://127.0.0.1:8132/api/points/<point-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "Operations Hub Updated",
    "latitude": 37.78,
    "longitude": -122.42,
    "color": "#ff8d57"
  }'
```

## Interaction model

- Click the globe to prefill latitude and longitude
- Shift-click the globe to create a point instantly using the current form values
- Use `Find my location` to request browser geolocation, show the live device marker, and center on it
- Click a point on the globe or an `Edit` action in the list to enter edit mode
- Drag a point on the globe to move it
- Alt-click a point on the globe or use the remove action in the list to delete it
- Use `Remove all saved points` to clear the persisted collection in one action
- Toggle auto-rotate on or off from the control panel

## Notes

- The backend serves both the API and the frontend assets.
- Point data persists in `data/points.json`.
- Browser geolocation generally requires `https` or `localhost`; insecure remote `http` access may not allow the current-location feature.
- Location access is requested only after selecting `Find my location`.
- Attribution is shown in the map UI for OpenFreeMap and OpenStreetMap contributors.
- Writes to `data/points.json` use an atomic replace so interrupted writes cannot leave a partially written JSON document.
