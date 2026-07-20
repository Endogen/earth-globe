import assert from "node:assert/strict";
import test from "node:test";

import { currentLocationToFeatureCollection, pointsToFeatureCollection } from "../../assets/js/map/geojson.js";
import { buildLocationError, LocationService } from "../../assets/js/location/service.js";
import { getWrappedPointCoordinates } from "../../assets/js/map/controller.js";
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
