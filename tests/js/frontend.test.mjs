import assert from "node:assert/strict";
import test from "node:test";

import {
  currentLocationToFeatureCollection,
  pointsToFeatureCollection,
  trackedDevicesToFeatureCollection
} from "../../assets/js/map/geojson.js";
import { buildLocationError, LocationService } from "../../assets/js/location/service.js";
import { getRotationStep, getWrappedPointCoordinates } from "../../assets/js/map/controller.js";
import {
  createSphereMesh,
  getCameraPosition,
  getEarthLayerSettings,
  getLocalGroundProjection,
  invertMatrix,
  pickTextureSource
} from "../../assets/js/map/earth-layer.js";
import {
  DevicesStore,
  getDeviceRefreshDelay,
  getDeviceRefreshStatus
} from "../../assets/js/state/devices-store.js";
import {
  getSiderealAngle,
  getSolarElevation,
  getSolarPosition,
  getSunDirection,
  getSurfaceVector
} from "../../assets/js/map/solar.js";
import {
  escapeHtml,
  formatApiErrorDetail,
  normalizeCoordinates,
  normalizeLongitude
} from "../../assets/js/utils/formatters.js";
import { getDevicePresence } from "../../assets/js/ui/controller.js";

test("normalizes coordinates into API-safe ranges", () => {
  assert.equal(normalizeLongitude(181), -179);
  assert.equal(normalizeLongitude(-181), 179);
  assert.deepEqual(normalizeCoordinates({ latitude: 95, longitude: 540 }), { latitude: 90, longitude: -180 });
});

test("wraps dateline-adjacent points into tight map bounds", () => {
  const coordinates = getWrappedPointCoordinates([
    { latitude: 1, longitude: 179 },
    { latitude: -1, longitude: -179 }
  ]);
  const longitudes = coordinates.map(([longitude]) => longitude);

  assert.equal(Math.max(...longitudes) - Math.min(...longitudes), 2);
});

test("formats FastAPI validation details for people", () => {
  const message = formatApiErrorDetail([
    { loc: ["body", "label"], msg: "String should have at least 1 character" },
    { loc: ["body", "latitude"], msg: "Input should be less than or equal to 90" }
  ]);

  assert.equal(
    message,
    "label: String should have at least 1 character · latitude: Input should be less than or equal to 90"
  );
});

test("escapes popup labels and creates GeoJSON features", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

  const collection = pointsToFeatureCollection([
    { id: "one", label: "One", latitude: 10, longitude: 20, color: "#ff8d57", created_at: "2026-01-01" }
  ]);
  assert.deepEqual(collection.features[0].geometry.coordinates, [20, 10]);
  assert.deepEqual(currentLocationToFeatureCollection(null).features, []);
});

test("maps only devices with received locations onto the globe", () => {
  const collection = trackedDevicesToFeatureCollection([
    { id: "waiting", name: "Waiting phone", latest_location: null },
    {
      id: "located",
      name: "Located phone",
      latest_location: {
        latitude: 52.52,
        longitude: 13.405,
        accuracy: 7.5,
        captured_at: "2026-07-21T10:30:00Z"
      }
    }
  ]);

  assert.equal(collection.features.length, 1);
  assert.deepEqual(collection.features[0].geometry.coordinates, [13.405, 52.52]);
  assert.equal(collection.features[0].properties.label, "Located phone");
});

test("derives connected, offline, and locating device states", () => {
  const now = Date.parse("2026-07-21T10:30:00Z");
  assert.deepEqual(getDevicePresence({ last_seen_at: "2026-07-21T10:29:30Z" }, now), {
    state: "online",
    label: "Connected"
  });
  assert.deepEqual(getDevicePresence({ last_seen_at: "2026-07-21T10:20:00Z" }, now), {
    state: "offline",
    label: "Offline"
  });
  assert.deepEqual(getDevicePresence({ active_request: { status: "locating" } }, now), {
    state: "waiting",
    label: "Getting GPS fix"
  });
  assert.equal(getDevicePresence({ active_request: { status: "delivered" } }, now).label, "Request delivered");
});

test("slows device refreshes when the page is hidden", () => {
  assert.equal(getDeviceRefreshDelay(), 4_000);
  assert.equal(getDeviceRefreshDelay({ hasActiveRequest: true }), 750);
  assert.equal(getDeviceRefreshDelay({ hidden: true }), 20_000);
  assert.equal(getDeviceRefreshDelay({ hidden: true, hasActiveRequest: true }), 5_000);
  assert.equal(getDeviceRefreshDelay({ retrying: true }), 8_000);
});

test("preserves useful tracking feedback while background state is unchanged", () => {
  assert.equal(getDeviceRefreshStatus(), null);
  assert.equal(
    getDeviceRefreshStatus({ previousDeviceCount: 1, deviceCount: 1 }),
    null
  );
  assert.equal(
    getDeviceRefreshStatus({ hasActiveRequest: true }),
    "Waiting for the requested location…"
  );
  assert.equal(
    getDeviceRefreshStatus({ hadActiveRequest: true }),
    "Device status is live. Location timestamps and accuracy are shown below."
  );
  assert.equal(
    getDeviceRefreshStatus({ previousDeviceCount: 0, deviceCount: 1 }),
    "Device status is live. Location timestamps and accuracy are shown below."
  );
});

test("device store publishes requested and removed device state", async () => {
  let devices = [{ id: "phone-1", name: "Phone" }];
  const api = {
    async listDevices() {
      return devices;
    },
    async requestDeviceLocation(deviceId) {
      devices = [{ ...devices[0], active_request: { id: "request-1", device_id: deviceId, status: "pending" } }];
      return devices[0].active_request;
    },
    async deleteDevice(deviceId) {
      const removed = devices.find((device) => device.id === deviceId);
      devices = devices.filter((device) => device.id !== deviceId);
      return removed;
    }
  };
  const store = new DevicesStore(api);
  const snapshots = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));

  await store.load();
  await store.requestLocation("phone-1");
  assert.equal(store.snapshot()[0].active_request.status, "pending");
  await store.remove("phone-1");
  assert.deepEqual(store.snapshot(), []);
  assert.ok(snapshots.length >= 4);
});

test("calculates expected solar declination at equinoxes and solstices", () => {
  const marchEquinox = getSolarPosition(new Date("2024-03-20T03:06:00Z"));
  const juneSolstice = getSolarPosition(new Date("2024-06-20T20:51:00Z"));
  const decemberSolstice = getSolarPosition(new Date("2024-12-21T09:20:00Z"));

  assert.ok(Math.abs(marchEquinox.latitude) < 0.1);
  assert.ok(Math.abs(juneSolstice.latitude - 23.44) < 0.1);
  assert.ok(Math.abs(decemberSolstice.latitude + 23.44) < 0.1);
});

test("places the Sun at the zenith above the subsolar point", () => {
  const solarPosition = getSolarPosition(new Date("2026-07-20T12:00:00Z"));
  const subsolarElevation = getSolarElevation(
    solarPosition,
    solarPosition.latitude,
    solarPosition.longitude
  );
  const antiSolarElevation = getSolarElevation(
    solarPosition,
    -solarPosition.latitude,
    solarPosition.longitude + 180
  );

  assert.ok(Math.abs(subsolarElevation - 90) < 1e-8);
  assert.ok(Math.abs(antiSolarElevation + 90) < 1e-8);
});

test("points the Sun vector at the subsolar point in the globe's frame", () => {
  const solarPosition = getSolarPosition(new Date("2026-07-20T12:00:00Z"));
  const sun = getSunDirection(solarPosition);
  const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  const elevationFromVector = (latitude, longitude) =>
    (Math.asin(dot(getSurfaceVector(latitude, longitude), sun)) * 180) / Math.PI;

  assert.ok(Math.abs(Math.hypot(...sun) - 1) < 1e-12);
  assert.deepEqual(getSurfaceVector(0, 0).map((value) => Math.round(value)), [0, 0, 1]);
  assert.deepEqual(getSurfaceVector(0, 90).map((value) => Math.round(value)), [1, 0, 0]);
  assert.deepEqual(getSurfaceVector(90, 0).map((value) => Math.round(value)), [0, 1, 0]);
  for (const [latitude, longitude] of [[52.5, 13.4], [-33.9, 151.2], [71, -156.8], [-89, 40]]) {
    const expected = getSolarElevation(solarPosition, latitude, longitude);
    assert.ok(Math.abs(elevationFromVector(latitude, longitude) - expected) < 1e-9);
  }
});

test("tracks Greenwich sidereal time for the starfield", () => {
  const degrees = (value) => (value * 180) / Math.PI;
  assert.ok(Math.abs(degrees(getSiderealAngle(new Date("2000-01-01T12:00:00Z"))) - 280.46061837) < 1e-6);
  const oneSolarDay = degrees(getSiderealAngle(new Date("2026-03-02T00:00:00Z")))
    - degrees(getSiderealAngle(new Date("2026-03-01T00:00:00Z")));
  assert.ok(Math.abs(((oneSolarDay + 360) % 360) - 0.9856) < 1e-3);
});

test("builds a 16-bit sphere mesh that reaches both poles and the antimeridian", () => {
  const { vertices, indices } = createSphereMesh(2.5);
  const longitudes = vertices.filter((_, index) => index % 2 === 0);
  const latitudes = vertices.filter((_, index) => index % 2 === 1);

  assert.equal(vertices.length / 2, 145 * 73);
  assert.equal(indices.length, 144 * 72 * 6);
  assert.equal(Math.max(...latitudes), 90);
  assert.equal(Math.min(...latitudes), -90);
  assert.equal(Math.min(...longitudes), -180);
  assert.equal(Math.max(...longitudes), 180);
  assert.ok(Math.max(...indices) < vertices.length / 2);
  assert.throws(() => createSphereMesh(0.5), RangeError);
});

test("recovers the camera position from a perspective view-projection matrix", () => {
  const eye = [0.4, -1.2, 3.1];
  const f = 1 / Math.tan(0.35);
  // Column-major perspective * translate(-eye) with near 0.1 / far 100.
  const [near, far] = [0.1, 100];
  const projection = [f / 1.5, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  const matrix = projection.slice();
  for (let row = 0; row < 4; row += 1) {
    matrix[12 + row] = projection[12 + row] - eye.reduce((sum, value, axis) => sum + projection[axis * 4 + row] * value, 0);
  }

  getCameraPosition(Float64Array.from(matrix)).forEach((value, axis) => assert.ok(Math.abs(value - eye[axis]) < 1e-9));
  assert.equal(getCameraPosition(new Float64Array(16)), null);
});

test("inverts matrices and re-bases the ground projection on the view centre", () => {
  const multiply = (a, b) => {
    const out = new Float64Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] = [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
      }
    }
    return out;
  };
  // A camera 0.001 units above the mercator point (0.53, 0.35), pitched 60°: street-level scale.
  const [x0, y0, height, pitch] = [0.53, 0.35, 0.001, Math.PI / 3];
  const f = 1 / Math.tan(0.35);
  const [near, far] = [0.0001, 0.01];
  const projection = [f / 1.4, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  const [c, s] = [Math.cos(pitch), Math.sin(pitch)];
  // Mercator y grows southwards, so a camera looking north sits south (+y) of its target.
  const cameraOffset = [0, height * Math.tan(pitch), height];
  const rotation = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  const translation = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -(x0 + cameraOffset[0]), -(y0 + cameraOffset[1]), -cameraOffset[2], 1];
  const matrix = multiply(projection, multiply(rotation, translation));

  const identity = multiply(matrix, invertMatrix(matrix));
  identity.forEach((value, index) => assert.ok(Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-9));
  assert.equal(invertMatrix(new Float64Array(16)), null);

  const ground = getLocalGroundProjection(matrix);
  assert.ok(Math.abs(ground.origin[0] - x0) < 1e-12);
  assert.ok(Math.abs(ground.origin[1] - y0) < 1e-12);
  // Re-based, the screen centre unprojects onto the ground at the local origin.
  const inverse = ground.inverseLocal;
  const unproject = (z) => {
    const point = [0, 1, 2, 3].map((row) => inverse[8 + row] * z + inverse[12 + row]);
    return point.slice(0, 3).map((value) => value / point[3]);
  };
  const [a, b] = [unproject(-1), unproject(1)];
  const t = a[2] / (a[2] - b[2]);
  assert.ok(Math.abs(a[0] + (b[0] - a[0]) * t) < 1e-12);
  assert.ok(Math.abs(a[1] + (b[1] - a[1]) * t) < 1e-12);
});

test("blends from orbital imagery to a readable map as the camera zooms in", () => {
  const orbit = getEarthLayerSettings(1.6);
  const street = getEarthLayerSettings(14);

  assert.equal(orbit.imagery, 1);
  assert.equal(orbit.atmosphere, 1);
  assert.equal(street.imagery, 0);
  assert.equal(street.glint, 0);
  assert.equal(street.atmosphere, 0);
  assert.ok(street.maxDarkness < orbit.maxDarkness);
  assert.equal(getEarthLayerSettings(1.6, 0).glint, 0);
});

test("uses the sharpest night-lights texture the GPU can hold", () => {
  const sources = [{ url: "8k", width: 8192 }, { url: "4k", width: 4096 }];

  assert.equal(pickTextureSource(sources, 16_384).url, "8k");
  assert.equal(pickTextureSource(sources, 8192).url, "8k");
  assert.equal(pickTextureSource(sources, 4096).url, "4k");
  assert.equal(pickTextureSource(sources, 2048).url, "4k");
});

test("rotates the globe smoothly, easing in and stopping when zoomed in", () => {
  const step = (overrides) =>
    getRotationStep({ degreesPerSecond: 3, zoom: 1.7, maxZoom: 3.4, elapsedMs: 16, rampProgress: 1, ...overrides });

  assert.ok(Math.abs(step({}) - 3 * 0.5 * 0.016) < 1e-12);
  assert.equal(step({ rampProgress: 0 }), 0);
  assert.ok(step({ rampProgress: 0.5 }) < step({}));
  assert.equal(step({ zoom: 3.5 }), 0);
  assert.equal(step({ elapsedMs: 0 }), 0);
  assert.equal(step({ elapsedMs: 5_000 }), step({ elapsedMs: 100 }));
});

test("turns geolocation failures into actionable messages", () => {
  assert.match(buildLocationError({ code: 1 }).message, /Allow it for this site/);
  assert.match(buildLocationError({ code: 2 }).message, /Location Services and Wi-Fi/);
  assert.match(buildLocationError({ code: 3 }).message, /timed out/);
});

test("requests a cache-friendly balanced location fix by default", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const secureContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  let capturedOptions;
  let successCallback;
  let clearedWatchId = null;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      geolocation: {
        watchPosition(success, _error, options) {
          successCallback = success;
          capturedOptions = options;
          return 17;
        },
        clearWatch(watchId) {
          clearedWatchId = watchId;
        }
      }
    }
  });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });

  try {
    const service = new LocationService();
    const locationPromise = service.ensureTracking();
    assert.deepEqual(capturedOptions, {
      enableHighAccuracy: false,
      maximumAge: 300_000,
      timeout: 20_000
    });

    successCallback({
      coords: { latitude: 52.52, longitude: 13.405, accuracy: 120 },
      timestamp: Date.parse("2026-07-20T12:00:00Z")
    });
    assert.deepEqual(await locationPromise, {
      latitude: 52.52,
      longitude: 13.405,
      accuracy: 120,
      timestamp: "2026-07-20T12:00:00.000Z"
    });
    service.stopTracking();
    assert.equal(clearedWatchId, 17);
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    if (secureContextDescriptor) {
      Object.defineProperty(globalThis, "isSecureContext", secureContextDescriptor);
    } else {
      delete globalThis.isSecureContext;
    }
  }
});

test("device refresh cannot restore private data after locking", async () => {
  let resolveLoad;
  const store = new DevicesStore({ listDevices: () => new Promise((resolve) => { resolveLoad = resolve; }) });
  const load = store.load();
  store.clear();
  resolveLoad([{ id: "private-phone" }]);
  await load;
  assert.deepEqual(store.snapshot(), []);
});

test("only the newest device refresh is applied", async () => {
  const resolvers = [];
  const store = new DevicesStore({ listDevices: () => new Promise((resolve) => resolvers.push(resolve)) });
  const first = store.load();
  const second = store.load();
  resolvers[1]([{ id: "current" }]);
  await second;
  resolvers[0]([{ id: "old" }]);
  await first;
  assert.equal(store.snapshot()[0].id, "current");
});

test("locking discards pending point saves and queued mutations", async () => {
  const { PointsStore } = await import("../../assets/js/state/points-store.js");
  let finish;
  let calls = 0;
  const store = new PointsStore({ createPoint: () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const first = store.add({ label: "Private" });
  await Promise.resolve();
  const second = store.add({ label: "Queued" });
  store.reset();
  finish({ id: "private", label: "Private" });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(store.snapshot(), []);
});

test("API uses cookie sessions, handles empty responses, and preserves status codes", async (t) => {
  const { ApiClient } = await import("../../assets/js/api/client.js");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  });
  const api = new ApiClient();
  assert.equal(await api.unlock("a-private-key"), null);
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), { control_key: "a-private-key" });
  let expired = false;
  api.addEventListener("unauthorized", () => { expired = true; });
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Session expired" }), {
    status: 401, headers: { "Content-Type": "application/json" }
  });
  await assert.rejects(api.listPoints(), (error) => error.status === 401);
  assert.equal(expired, true);
});

test("stopping geolocation settles the request and ignores late callbacks", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  let success;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { geolocation: {
    watchPosition(callback) { success = callback; return 1; }, clearWatch() {}
  } } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  try {
    const service = new LocationService();
    const pending = service.ensureTracking();
    service.stopTracking();
    await assert.rejects(pending, /stopped/);
    success({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: Date.now() });
    assert.equal(service.getCurrentLocation(), null);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    if (secureDescriptor) Object.defineProperty(globalThis, "isSecureContext", secureDescriptor);
    else delete globalThis.isSecureContext;
  }
});
