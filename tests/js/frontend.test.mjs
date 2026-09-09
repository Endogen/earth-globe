import assert from "node:assert/strict";
import test from "node:test";

import {
  currentLocationToFeatureCollection,
  pointsToFeatureCollection,
  trackedDevicesToFeatureCollection
} from "../../assets/js/map/geojson.js";
import { buildLocationError, LocationService } from "../../assets/js/location/service.js";
import { getWrappedPointCoordinates } from "../../assets/js/map/controller.js";
import {
  DevicesStore,
  getDeviceRefreshDelay,
  getDeviceRefreshStatus
} from "../../assets/js/state/devices-store.js";
import {
  createSolarTextureData,
  getNightOpacity,
  getSolarElevation,
  getSolarPosition
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

test("renders a seamless solar texture with dark and daylight hemispheres", () => {
  const solarPosition = getSolarPosition(new Date("2026-07-20T12:00:00Z"));
  const texture = createSolarTextureData(solarPosition, 360, 180);
  const pixelAlpha = (longitude, latitude) => {
    const wrappedLongitude = normalizeLongitude(longitude);
    const x = Math.min(texture.width - 1, Math.max(0, Math.floor(((wrappedLongitude + 180) / 360) * texture.width)));
    const mercatorY = (1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2;
    const y = Math.min(texture.height - 1, Math.max(0, Math.floor(mercatorY * texture.height)));
    return texture.pixels[(y * texture.width + x) * 4 + 3];
  };

  assert.equal(texture.pixels.length, 360 * 180 * 4);
  assert.ok(pixelAlpha(solarPosition.longitude, solarPosition.latitude) <= 1);
  assert.ok(pixelAlpha(solarPosition.longitude + 180, -solarPosition.latitude) >= 195);

  for (let y = 0; y < texture.height; y += 1) {
    const firstAlpha = texture.pixels[(y * texture.width) * 4 + 3];
    const lastAlpha = texture.pixels[(y * texture.width + texture.width - 1) * 4 + 3];
    assert.ok(Math.abs(firstAlpha - lastAlpha) <= 4);
  }
});

test("darkens continuously as solar elevation falls below the horizon", () => {
  const elevations = [0, -1, -6, -12, -18, -30, -60, -90];
  const opacities = elevations.map(getNightOpacity);

  assert.equal(opacities[0], 0);
  assert.ok(opacities.at(-1) <= 0.8);
  opacities.slice(1).forEach((opacity, index) => {
    assert.ok(opacity >= opacities[index]);
  });
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
