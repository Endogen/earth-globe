import assert from "node:assert/strict";
import test from "node:test";

import { currentLocationToFeatureCollection, pointsToFeatureCollection } from "../../assets/js/map/geojson.js";
import { getWrappedPointCoordinates } from "../../assets/js/map/controller.js";
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
