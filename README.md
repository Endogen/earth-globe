# Earth Marker Studio

Professional globe-based point editor with:

- Python backend using FastAPI
- MapLibre GL JS front end with globe projection
- astronomically accurate live day/night terminator with a smooth solar-elevation twilight gradient
- UTC date and time simulation controls for exploring seasonal daylight
- OSM-derived vector map styling via OpenFreeMap
- persisted point storage in `data/points.json`
- add, edit, move, and remove point workflows from both the map and the side panel
- modular frontend and backend code instead of a single browser script
- atomic JSON persistence and validated API payloads
- responsive desktop/mobile controls with reduced-motion support
- private Android device registration with one-time pairing codes
- on-demand, accuracy-aware device locations rendered separately from saved points
- authenticated workspace access with expiring HttpOnly sessions, hashed device credentials, revocation, and SQLite tracking history
- searchable saved points, visible request failures, and keyboard-friendly editor navigation
- cached point reads, cross-process write locks, and map rendering that pauses when hidden
- a sideloadable Android companion with a visible foreground connection and durable result retries
- Python API tests, JavaScript utility tests, and Android JVM tests

## Stack

- Backend: FastAPI + Uvicorn
- Frontend: MapLibre GL JS, modular ES modules, custom CSS
- Storage: local JSON repository
- Device tracking storage: SQLite
- Android companion: native Java, Android 8.0+, foreground service, fused location provider
- Map style: `https://tiles.openfreemap.org/styles/liberty`

## Project layout

```text
.
├── assets/
│   ├── js/
│   └── styles/
├── android/
│   └── app/
├── data/
│   └── points.json
├── downloads/
├── scripts/
│   └── build_android.sh
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

## Private Android tracking

The Android app does not collect location continuously. It keeps a visible foreground connection to the server, waits for an authenticated request, requests one high-accuracy fix, saves the result to a durable on-device outbox, and retries the upload until the server acknowledges it. The server also redelivers commands that were not completed.

### 1. Build the APK

Install Android SDK 36 and Java 17, then run:

```bash
./scripts/build_android.sh
```

This produces an installable, debug-signed personal APK at `downloads/earth-tracker.apk`. While the FastAPI app is running, the same file is available at `/downloads/earth-tracker.apk` and the website shows a Download APK button.

The debug signature is suitable for personal sideloading. Keep the same signing key if you want later APKs to install as updates over the existing app.
Debug builds allow plain HTTP only so a phone can reach a private LAN address during local testing; release builds reject cleartext traffic. Prefer HTTPS or an encrypted private network whenever possible because device credentials and coordinates are sensitive.

### 2. Make the server reachable

The phone must be able to reach the same FastAPI server address that you enter in the Android app.

- On a trusted home network, bind Uvicorn to the computer's LAN interface and use its private IP address.
- For access away from home, expose the server through an authenticated private network or an HTTPS reverse proxy. Do not expose an unencrypted public HTTP endpoint.
- `localhost` on the phone refers to the phone itself, not the computer running this project.

Example for a trusted LAN:

```bash
uv run uvicorn earth_globe_demo.main:app --host 0.0.0.0 --port 8132
```

### 3. Unlock and pair

On first startup, the server generates a random control key in `data/tracking-admin-token.txt` with owner-only filesystem permissions. You can instead supply a stable secret with at least 24 characters:

```bash
EARTH_GLOBE_ADMIN_TOKEN='replace-with-a-long-random-secret' \
  uv run uvicorn earth_globe_demo.main:app --host 0.0.0.0 --port 8132
```

Then:

1. Open the website and paste the control key into Workspace access. This unlocks both saved points and Android devices.
2. Create a one-time pairing code.
3. Install and open Earth Tracker on the phone.
4. Enter the server base address, device name, and pairing code.
5. Grant precise location, choose Allow all the time, allow notifications, and disable battery restrictions for Earth Tracker.
6. Press Start reliable tracking and leave the persistent ready notification enabled.

The pairing code is valid once for ten minutes. Location requests also remain queued for ten minutes if the phone is temporarily offline. A location captured before a timeout is still accepted when the durable outbox reconnects later. The resulting device credential is stored only in the app's private storage, excluded from Android backup and device transfer, and represented on the server only by its SHA-256 hash. Unpairing from the website revokes the credential and deletes that device's location history.

### Reliability limits

The foreground connection and retry protocol are designed for reliable personal use, but Android cannot provide an absolute guarantee. A request cannot complete while the phone has no network, Location Services are disabled, the app is force-stopped, or the device is powered off. The website therefore shows connection state, request state, location capture time, accuracy, and whether a recent cached fix had to be used.

## Workspace access and upgrades

Version 0.4 protects **all** point reads and writes with the same control key used for device administration. Reload the browser after updating to load the versioned frontend modules. Existing point files and device registrations continue to work. API scripts must now include `Authorization: Bearer <control-key>` for `/api/points`.

The browser exchanges the control key for a random session cookie; the key is cleared from the form and never written to browser storage. Sessions are stored as hashes in SQLite, expire after eight hours, and use `HttpOnly`, `SameSite=Strict`, and `Secure` on HTTPS. Lock revokes the session and clears visible points, device details, browser geolocation, and the selected map view. Other open tabs are notified. Changing the server control key and restarting invalidates sessions issued under the old key.

Login and pairing each allow ten attempts per client IP per minute. Rate-limit state is shared through SQLite. If you run behind an HTTPS reverse proxy, preserve the public Host and configure Uvicorn to trust forwarded headers **only from your proxy**, so origin checks, Secure cookies, and client-IP limits work correctly. API responses use `Cache-Control: no-store`; application assets revalidate to avoid stale authentication code after upgrades.

This remains a private, single-owner workspace. It does not provide separate user accounts, roles, MFA, or SSO. The local HTTP development workflow is supported; use HTTPS for remote access. If you change the map style or external asset hosts, update the content security policy in `main.py` too.

Point storage uses cross-process file locks on a local filesystem and an atomic JSON replace. Reads cache validated points until the file changes. SQLite connections are explicitly closed after each operation. The globe suspends rotation in hidden tabs, skips unchanged device geometry, and batches solar slider updates into animation frames.

## Quality checks

```bash
uv run ruff check src tests
uv run pytest
npm test
uv run python scripts/benchmark_storage.py
cd android && ./gradlew assembleDebug lintDebug testDebugUnitTest
```

## API

- `GET /api/health`
- `GET /api/config`
- `POST /api/auth/session` (exchange control key for an eight-hour browser session)
- `GET /api/auth/session` (check session)
- `DELETE /api/auth/session` (revoke session)
- `GET /api/points` (control key or session)
- `DELETE /api/points` (control key or session)
- `POST /api/points` (control key or session)
- `PUT /api/points/{point_id}` (control key or session)
- `DELETE /api/points/{point_id}` (control key or session)
- `GET /api/tracking/status`
- `POST /api/devices/pairing-codes` (control key)
- `GET /api/devices` (control key)
- `POST /api/devices/{device_id}/location-requests` (control key)
- `DELETE /api/devices/{device_id}` (control key)
- `POST /api/device/register` (one-time pairing code)
- `GET /api/device/commands` (device credential, long poll)
- `POST /api/device/location-results` (device credential)
- `POST /api/device/location-failures` (device credential)

Set `EARTH_GLOBE_ADMIN_TOKEN` in your shell to your existing control key before running these examples.

Example create request:

```bash
curl -X POST http://127.0.0.1:8132/api/points \
  -H "Authorization: Bearer ${EARTH_GLOBE_ADMIN_TOKEN}" \
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
  -H "Authorization: Bearer ${EARTH_GLOBE_ADMIN_TOKEN}" \
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
- Use the section shortcuts to jump to the editor, saved points, Android devices, or solar controls
- Filter the saved-point list by label without hiding other points on the globe
- Toggle auto-rotate on or off from the control panel
- Keep `Live time` enabled to follow the current Sun position, or disable it to simulate another UTC date and time

## Notes

- The backend serves both the API and the frontend assets.
- Point data persists in `data/points.json`.
- Device registrations, requests, and location samples persist in `data/tracking.sqlite3` and are intentionally excluded from Git.
- The browser uses an expiring HttpOnly session cookie. API scripts can continue to use the control key as a Bearer header.
- Browser geolocation generally requires `https` or `localhost`; insecure remote `http` access may not allow the current-location feature.
- Location access is requested only after selecting `Find my location`.
- Attribution is shown in the map UI for OpenFreeMap and OpenStreetMap contributors.
- Solar calculations run locally in the browser and require no external astronomy service.
- Writes to `data/points.json` use an atomic replace so interrupted writes cannot leave a partially written JSON document.
