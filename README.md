# Earth Marker Studio

Professional globe-based point editor with:

- Python backend using FastAPI
- MapLibre GL JS front end with globe projection
- OSM-derived vector map styling via OpenFreeMap
- persisted point storage in `data/points.json`
- add, edit, move, and remove point workflows from both the map and the side panel
- modular frontend and backend code instead of a single browser script

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
├── index.html
├── pyproject.toml
└── README.md
```

## Run locally

Install dependencies:

```bash
cd /home/endogen/earth-globe-demo
python3 -m pip install -e .
```

Start the app:

```bash
cd /home/endogen/earth-globe-demo
python3 -m uvicorn earth_globe_demo.main:app --reload --host 0.0.0.0 --port 8132
```

Then open `http://127.0.0.1:8132` on the server itself.

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
- Attribution is shown in the map UI for OpenFreeMap and OpenStreetMap contributors.
- Tailscale `serve` and `funnel` are disabled by tailnet policy on this node, so remote access currently uses the node's Tailscale IP / MagicDNS hostname directly.
