import { escapeHtml, formatCoordinates, normalizeCoordinates, normalizeLongitude } from "../utils/formatters.js?v=0.5.0";
import {
  currentLocationToFeatureCollection,
  emptyFeatureCollection,
  pointsToFeatureCollection,
  trackedDevicesToFeatureCollection
} from "./geojson.js?v=0.5.0";
import { EarthLayer } from "./earth-layer.js?v=0.5.0";
import { getSolarElevation, getSolarPosition, smoothStep } from "./solar.js?v=0.5.0";

const SOURCE_ID = "points";
const HALO_LAYER_ID = "points-halo";
const CORE_LAYER_ID = "points-core";
const LABEL_LAYER_ID = "points-labels";
const INTERACTIVE_LAYERS = [CORE_LAYER_ID, LABEL_LAYER_ID];
const CURRENT_LOCATION_SOURCE_ID = "current-location";
const CURRENT_LOCATION_HALO_LAYER_ID = "current-location-halo";
const CURRENT_LOCATION_CORE_LAYER_ID = "current-location-core";
const CURRENT_LOCATION_LABEL_LAYER_ID = "current-location-label";
const TRACKED_DEVICE_SOURCE_ID = "tracked-devices";
const TRACKED_DEVICE_HALO_LAYER_ID = "tracked-devices-halo";
const TRACKED_DEVICE_CORE_LAYER_ID = "tracked-devices-core";
const TRACKED_DEVICE_LABEL_LAYER_ID = "tracked-devices-label";
// Seconds for auto-rotation to ease back up to full speed after an interaction.
const ROTATION_RAMP_SECONDS = 1.6;
// Longest frame gap that still advances the rotation, so a stalled tab does not jump the globe.
const MAX_ROTATION_FRAME_MS = 100;
// Zoom ranges over which low-zoom labels fade in. From orbit the globe reads as a photograph, not an atlas.
const LABEL_FADE_ZOOMS = {
  label_country_1: [2.2, 2.8],
  label_country_2: [2.8, 3.4],
  label_country_3: [3.3, 3.9],
  water_name_point_label: [3, 3.6],
  water_name_line_label: [3.4, 4],
  label_city_capital: [3.4, 4],
  label_city: [3.8, 4.4]
};

function interpolateColor(from, to, amount) {
  const safeAmount = Math.min(1, Math.max(0, amount));
  const channel = (start, end) => Math.round(start + (end - start) * safeAmount);
  const fromChannels = from.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16));
  const toChannels = to.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16));
  return `rgb(${fromChannels.map((value, index) => channel(value, toChannels[index])).join(", ")})`;
}

/** Degrees of longitude to advance this frame; eases in after a pause and slows as the camera zooms in. */
export function getRotationStep({ degreesPerSecond, zoom, maxZoom, elapsedMs, rampProgress }) {
  if (zoom > maxZoom || elapsedMs <= 0) return 0;
  const zoomFactor = Math.max((maxZoom - zoom) / maxZoom, 0.2);
  const ramp = smoothStep(0, 1, rampProgress);
  return degreesPerSecond * zoomFactor * ramp * (Math.min(elapsedMs, MAX_ROTATION_FRAME_MS) / 1000);
}

export function getWrappedPointCoordinates(points) {
  if (points.length < 2) {
    return points.map((point) => [normalizeLongitude(point.longitude), point.latitude]);
  }

  const sortedLongitudes = points
    .map((point) => normalizeLongitude(point.longitude))
    .sort((left, right) => left - right);
  let largestGap = -1;
  let gapStartIndex = 0;

  sortedLongitudes.forEach((longitude, index) => {
    const nextLongitude = index === sortedLongitudes.length - 1 ? sortedLongitudes[0] + 360 : sortedLongitudes[index + 1];
    const gap = nextLongitude - longitude;
    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = index;
    }
  });

  const intervalStart = sortedLongitudes[(gapStartIndex + 1) % sortedLongitudes.length];
  return points.map((point) => {
    let longitude = normalizeLongitude(point.longitude);
    if (longitude < intervalStart) {
      longitude += 360;
    }
    return [longitude, point.latitude];
  });
}

export class MapController {
  constructor({ containerId, onCoordinatePick, onQuickAddRequest, onPointSelect, onPointMoveRequest, onPointRemoveRequest }) {
    this.containerId = containerId;
    this.onCoordinatePick = onCoordinatePick;
    this.onQuickAddRequest = onQuickAddRequest;
    this.onPointSelect = onPointSelect;
    this.onPointMoveRequest = onPointMoveRequest;
    this.onPointRemoveRequest = onPointRemoveRequest;
    this.map = null;
    this.points = [];
    this.rotationEnabled = true;
    this.rotationDegreesPerSecond = 2.8;
    this.rotationMaxZoom = 3.4;
    this.defaultView = null;
    this.userInteracting = false;
    this.rotationFrame = null;
    this.lastRotationTime = null;
    this.rotationRamp = 0;
    this.autoRotating = false;
    this.resumeTimer = null;
    this.popup = null;
    this.popupPointId = null;
    this.dragState = null;
    this.suppressNextMapClick = false;
    this.currentLocation = null;
    this.trackedDevices = [];
    this.solarPosition = getSolarPosition();
    this.solarLive = true;
    this.earthLayer = null;
    this.deviceSourceKey = null;
    this.visibilityHandler = () => this.startRotation();
  }

  async mount(config) {
    if (!window.maplibregl) {
      throw new Error("MapLibre GL JS failed to load");
    }

    this.defaultView = config.initial_view;
    this.rotationEnabled = config.rotation.enabled;
    this.rotationDegreesPerSecond = config.rotation.degrees_per_second;
    this.rotationMaxZoom = config.rotation.max_zoom;

    this.map = new window.maplibregl.Map({
      container: this.containerId,
      style: config.map_style_url,
      center: [config.initial_view.longitude, config.initial_view.latitude],
      zoom: config.initial_view.zoom,
      minZoom: config.initial_view.min_zoom,
      maxZoom: config.initial_view.max_zoom,
      bearing: config.initial_view.bearing,
      pitch: config.initial_view.pitch,
      antialias: true,
      attributionControl: false,
      renderWorldCopies: true
    });

    this.map.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.addControl(
      new window.maplibregl.AttributionControl({
        compact: true,
        customAttribution: config.custom_attribution
      }),
      "bottom-right"
    );

    this.map.on("style.load", () => {
      this.map.setProjection({ type: "globe" });
    });

    await new Promise((resolve, reject) => {
      let timeout = null;
      // Individual tile errors can recover; give the style a bounded time to load. Background tabs
      // get no animation frames, so the map cannot load there and the clock only runs while visible.
      const armTimeout = () => {
        clearTimeout(timeout);
        timeout = document.hidden
          ? null
          : setTimeout(() => {
            cleanup();
            reject(new Error("The map did not load within 20 seconds"));
          }, 20_000);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.map.off("load", loaded);
        document.removeEventListener("visibilitychange", armTimeout);
      };
      const loaded = () => { cleanup(); resolve(); };
      document.addEventListener("visibilitychange", armTimeout);
      armTimeout();
      this.map.once("load", loaded);
    });

    this.#installEarthLayer();
    this.#fadeLowZoomLabels();
    this.#installPointLayers();
    this.#installCurrentLocationLayers();
    this.#installTrackedDeviceLayers();
    this.#bindMapInteractions();
    this.#updateLocalSky();
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.startRotation();
  }

  setPoints(points) {
    this.points = points;
    this.#setSourceData(points);
    this.#syncPopup();
  }

  setRotationEnabled(enabled) {
    this.rotationEnabled = enabled;
    if (this.map) this.startRotation();
  }

  setCurrentLocation(location) {
    this.currentLocation = location;
    this.#setCurrentLocationData(location);
  }

  setTrackedDevices(devices) {
    this.trackedDevices = devices;
    const key = JSON.stringify(devices.map(({ id, name, latest_location }) => ({ id, name, latest_location })));
    if (this.deviceSourceKey === key) return;
    this.deviceSourceKey = key;
    this.#setTrackedDeviceData(devices);
  }

  setSolarDate(value, { live = false } = {}) {
    this.solarPosition = getSolarPosition(value);
    this.solarLive = live;
    this.earthLayer?.setSun(this.solarPosition, { live });
    this.#updateLocalSky();
    return this.solarPosition;
  }

  zoomIn() {
    this.map?.easeTo({ zoom: this.map.getZoom() + 0.55, duration: 350 });
  }

  zoomOut() {
    this.map?.easeTo({ zoom: this.map.getZoom() - 0.55, duration: 350 });
  }

  resetView({ animate = true } = {}) {
    if (!this.map || !this.defaultView) {
      return;
    }

    this.map.easeTo({
      center: [this.defaultView.longitude, this.defaultView.latitude],
      zoom: this.defaultView.zoom,
      bearing: this.defaultView.bearing,
      pitch: this.defaultView.pitch,
      duration: animate ? 900 : 0
    });
  }

  framePoints(points = this.points) {
    if (!this.map || points.length === 0) {
      return;
    }

    if (points.length === 1) {
      this.focusPoint(points[0]);
      return;
    }

    const bounds = new window.maplibregl.LngLatBounds();
    getWrappedPointCoordinates(points).forEach((coordinates) => bounds.extend(coordinates));
    this.map.fitBounds(bounds, { padding: 90, duration: 900, maxZoom: 14.5 });
  }

  focusPoint(point) {
    if (!this.map) {
      return;
    }

    this.map.flyTo({
      center: [point.longitude, point.latitude],
      zoom: Math.max(this.map.getZoom(), 13.8),
      speed: 0.75,
      essential: false
    });

    this.popup?.remove();
    this.popupPointId = point.id;
    this.popup = new window.maplibregl.Popup({ offset: 18, focusAfterOpen: false })
      .setLngLat([point.longitude, point.latitude])
      .setHTML(this.#popupHtml(point))
      .addTo(this.map);
    this.popup.on("close", () => {
      this.popup = null;
      this.popupPointId = null;
    });
  }

  focusTrackedDevice(device) {
    const location = device?.latest_location;
    if (!this.map || !location) {
      return false;
    }

    this.#pauseRotation();
    this.map.flyTo({
      center: [location.longitude, location.latitude],
      zoom: Math.max(this.map.getZoom(), 14.8),
      speed: 0.75,
      essential: false
    });
    this.popup?.remove();
    this.popupPointId = null;
    this.popup = new window.maplibregl.Popup({ offset: 18, focusAfterOpen: false })
      .setLngLat([location.longitude, location.latitude])
      .setHTML(`<strong>${escapeHtml(device.name)}</strong><br /><span>${escapeHtml(
        formatCoordinates(location.latitude, location.longitude)
      )} · ±${Math.round(location.accuracy)} m</span>`)
      .addTo(this.map);
    this.popup.on("close", () => {
      this.popup = null;
    });
    return true;
  }

  centerOnCurrentLocation() {
    if (!this.map || !this.currentLocation) {
      return false;
    }

    this.#pauseRotation();
    this.map.flyTo({
      center: [this.currentLocation.longitude, this.currentLocation.latitude],
      zoom: Math.max(this.map.getZoom(), 14.8),
      speed: 0.75,
      essential: false
    });
    return true;
  }

  startRotation() {
    window.cancelAnimationFrame(this.rotationFrame);
    this.rotationFrame = null;
    this.lastRotationTime = null;
    this.rotationRamp = 0;
    if (!this.map || !this.rotationEnabled || document.hidden) return;

    const step = (time) => {
      if (!this.map) return;
      this.rotationFrame = window.requestAnimationFrame(step);
      const elapsedMs = this.lastRotationTime === null ? 0 : time - this.lastRotationTime;
      this.lastRotationTime = time;

      if (this.userInteracting || this.dragState || this.map.isEasing() || this.map.isMoving()) {
        this.rotationRamp = 0;
        return;
      }

      this.rotationRamp = Math.min(1, this.rotationRamp + Math.min(elapsedMs, MAX_ROTATION_FRAME_MS) / 1000 / ROTATION_RAMP_SECONDS);
      const degrees = getRotationStep({
        degreesPerSecond: this.rotationDegreesPerSecond,
        zoom: this.map.getZoom(),
        maxZoom: this.rotationMaxZoom,
        elapsedMs,
        rampProgress: this.rotationRamp
      });
      if (degrees === 0) return;

      const center = this.map.getCenter();
      this.autoRotating = true;
      try {
        this.map.jumpTo({ center: [center.lng - degrees, center.lat] });
      } finally {
        this.autoRotating = false;
      }
    };

    this.rotationFrame = window.requestAnimationFrame(step);
  }

  destroy() {
    window.cancelAnimationFrame(this.rotationFrame);
    window.clearTimeout(this.resumeTimer);
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.popup?.remove();
    this.map?.remove();
    this.map = null;
    this.earthLayer = null;
  }

  #installEarthLayer() {
    // Draw above every base-map fill and line (roads, bridges, borders) but beneath all labels.
    const layers = this.map.getStyle().layers;
    const lastBaseIndex = layers.findLastIndex((layer) => layer.type !== "symbol");
    const beforeId = layers[lastBaseIndex + 1]?.id;
    this.earthLayer = new EarthLayer({ solarPosition: this.solarPosition, live: this.solarLive });
    this.map.addLayer(this.earthLayer, beforeId);
  }

  #fadeLowZoomLabels() {
    Object.entries(LABEL_FADE_ZOOMS).forEach(([layerId, [start, end]]) => {
      const layer = this.map.getLayer(layerId);
      if (!layer || layer.type !== "symbol") return;
      const fade = ["interpolate", ["linear"], ["zoom"], start, 0, end, 1];
      if (this.map.getPaintProperty(layerId, "text-opacity") === undefined) {
        this.map.setPaintProperty(layerId, "text-opacity", fade);
      }
      if (this.map.getPaintProperty(layerId, "icon-opacity") === undefined) {
        this.map.setPaintProperty(layerId, "icon-opacity", fade);
      }
      // Hidden labels would still claim collision space, so keep them out of placement entirely.
      this.map.setLayerZoomRange(layerId, Math.max(layer.minzoom ?? 0, start), layer.maxzoom ?? 24);
    });
  }

  #installPointLayers() {
    this.map.addSource(SOURCE_ID, {
      type: "geojson",
      data: pointsToFeatureCollection(this.points)
    });

    this.map.addLayer({
      id: HALO_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 5, 5, 16],
        "circle-opacity": 0.24,
        "circle-blur": 0.85
      }
    });

    this.map.addLayer({
      id: CORE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-color": ["get", "color"],
        "circle-stroke-color": "rgba(255, 255, 255, 0.95)",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 1, 1.2, 5, 1.8],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 5, 8]
      }
    });

    this.map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.25],
        "text-size": ["interpolate", ["linear"], ["zoom"], 1, 10, 5, 13],
        "text-anchor": "top",
        "text-allow-overlap": false
      },
      paint: {
        "text-color": "#f3f8ff",
        "text-halo-color": "rgba(4, 12, 20, 0.96)",
        "text-halo-width": 1.2
      }
    });
  }

  #installCurrentLocationLayers() {
    this.map.addSource(CURRENT_LOCATION_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection()
    });

    this.map.addLayer({
      id: CURRENT_LOCATION_HALO_LAYER_ID,
      type: "circle",
      source: CURRENT_LOCATION_SOURCE_ID,
      paint: {
        "circle-color": "rgba(103, 211, 255, 0.42)",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 9, 14, 24],
        "circle-opacity": 0.58,
        "circle-blur": 0.9
      }
    });

    this.map.addLayer({
      id: CURRENT_LOCATION_CORE_LAYER_ID,
      type: "circle",
      source: CURRENT_LOCATION_SOURCE_ID,
      paint: {
        "circle-color": "#67d3ff",
        "circle-stroke-color": "rgba(255, 255, 255, 0.95)",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 14, 2.3],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4.5, 14, 8.5]
      }
    });

    this.map.addLayer({
      id: CURRENT_LOCATION_LABEL_LAYER_ID,
      type: "symbol",
      source: CURRENT_LOCATION_SOURCE_ID,
      minzoom: 6,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.25],
        "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10, 14, 13],
        "text-anchor": "top"
      },
      paint: {
        "text-color": "#ddf6ff",
        "text-halo-color": "rgba(4, 12, 20, 0.96)",
        "text-halo-width": 1.2
      }
    });
  }

  #installTrackedDeviceLayers() {
    this.map.addSource(TRACKED_DEVICE_SOURCE_ID, {
      type: "geojson",
      data: trackedDevicesToFeatureCollection(this.trackedDevices)
    });

    this.map.addLayer({
      id: TRACKED_DEVICE_HALO_LAYER_ID,
      type: "circle",
      source: TRACKED_DEVICE_SOURCE_ID,
      paint: {
        "circle-color": "rgba(132, 240, 174, 0.48)",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 10, 14, 26],
        "circle-opacity": 0.62,
        "circle-blur": 0.88
      }
    });

    this.map.addLayer({
      id: TRACKED_DEVICE_CORE_LAYER_ID,
      type: "circle",
      source: TRACKED_DEVICE_SOURCE_ID,
      paint: {
        "circle-color": "#84f0ae",
        "circle-stroke-color": "rgba(255, 255, 255, 0.96)",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 14, 2.4],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 5, 14, 9]
      }
    });

    this.map.addLayer({
      id: TRACKED_DEVICE_LABEL_LAYER_ID,
      type: "symbol",
      source: TRACKED_DEVICE_SOURCE_ID,
      minzoom: 3,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.3],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 14, 13],
        "text-anchor": "top"
      },
      paint: {
        "text-color": "#ddffe9",
        "text-halo-color": "rgba(4, 12, 20, 0.96)",
        "text-halo-width": 1.2
      }
    });
  }

  #bindMapInteractions() {
    this.map.on("click", (event) => {
      if (this.suppressNextMapClick) {
        this.suppressNextMapClick = false;
        return;
      }

      const features = this.map.queryRenderedFeatures(event.point, { layers: INTERACTIVE_LAYERS });
      const point = this.#pointFromFeatures(features);
      if (point) {
        if (event.originalEvent?.altKey) {
          this.onPointRemoveRequest?.(point.id);
          return;
        }

        this.focusPoint(point);
        this.onPointSelect?.(point);
        return;
      }

      const draft = normalizeCoordinates({
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng
      });

      this.onCoordinatePick?.(draft);
      if (event.originalEvent?.shiftKey) {
        this.onQuickAddRequest?.(draft);
      }
    });

    INTERACTIVE_LAYERS.forEach((layerId) => {
      this.map.on("mouseenter", layerId, () => {
        if (!this.dragState) {
          this.map.getCanvas().style.cursor = "pointer";
        }
      });

      this.map.on("mouseleave", layerId, () => {
        if (!this.dragState) {
          this.map.getCanvas().style.cursor = "";
        }
      });

    });

    this.map.on("mousedown", CORE_LAYER_ID, (event) => {
      if (event.originalEvent?.altKey) {
        return;
      }

      const point = this.#pointFromEvent(event);
      if (!point) {
        return;
      }

      event.preventDefault();
      this.#pauseRotation();
      this.dragState = {
        pointId: point.id,
        didMove: false
      };
      this.map.dragPan.disable();
      this.map.getCanvas().style.cursor = "grabbing";

      const onMouseMove = (moveEvent) => {
        if (!this.dragState) {
          return;
        }

        this.dragState.didMove = true;
        const coordinates = normalizeCoordinates({ latitude: moveEvent.lngLat.lat, longitude: moveEvent.lngLat.lng });
        this.#previewDraggedPoint(this.dragState.pointId, coordinates.latitude, coordinates.longitude);
      };

      const onMouseUp = (upEvent) => {
        const dragState = this.dragState;
        this.dragState = null;
        this.map.off("mousemove", onMouseMove);
        this.map.off("mouseup", onMouseUp);
        this.map.dragPan.enable();
        this.map.getCanvas().style.cursor = "";
        this.#setSourceData(this.points);

        if (!dragState) {
          return;
        }

        if (dragState.didMove) {
          this.suppressNextMapClick = true;
          const coordinates = normalizeCoordinates({ latitude: upEvent.lngLat.lat, longitude: upEvent.lngLat.lng });
          this.onPointMoveRequest?.({
            pointId: dragState.pointId,
            latitude: coordinates.latitude,
            longitude: coordinates.longitude
          });
        }
      };

      this.map.on("mousemove", onMouseMove);
      this.map.on("mouseup", onMouseUp);
    });

    ["dragstart", "zoomstart", "pitchstart", "rotatestart"].forEach((eventName) => {
      this.map.on(eventName, () => this.#pauseRotation());
    });

    this.map.on("moveend", () => {
      if (this.autoRotating) return;
      this.#updateLocalSky();
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = window.setTimeout(() => {
        if (!this.dragState) {
          this.userInteracting = false;
        }
      }, 900);
    });
  }

  #setSourceData(points) {
    const source = this.map?.getSource(SOURCE_ID);
    if (source) {
      source.setData(pointsToFeatureCollection(points));
    }
  }

  #setCurrentLocationData(location) {
    const source = this.map?.getSource(CURRENT_LOCATION_SOURCE_ID);
    if (source) {
      source.setData(currentLocationToFeatureCollection(location));
    }
  }

  #setTrackedDeviceData(devices) {
    const source = this.map?.getSource(TRACKED_DEVICE_SOURCE_ID);
    if (source) {
      source.setData(trackedDevicesToFeatureCollection(devices));
    }
  }

  #updateLocalSky() {
    // The orbital atmosphere is drawn per pixel by the Earth layer. MapLibre's sky only shows
    // above the horizon of pitched close-ups, so it follows the Sun at the view centre.
    // The Earth layer is only installed once the style has loaded; setSky throws before that.
    if (!this.earthLayer || !this.map?.setSky || !this.solarPosition) {
      return;
    }

    const center = this.map.getCenter();
    const solarElevation = getSolarElevation(this.solarPosition, center.lat, center.lng);
    const daylight = smoothStep(-12, 6, solarElevation);
    const skyColor = interpolateColor("#020711", "#3f7fc1", daylight);
    const horizonColor = interpolateColor("#071225", "#8ec9de", daylight);
    const fogColor = interpolateColor("#07101e", "#c4e3e9", daylight);

    const skyKey = `${skyColor}:${horizonColor}:${fogColor}`;
    if (this.skyKey === skyKey) return;
    this.skyKey = skyKey;

    this.map.setSky({
      "sky-color": skyColor,
      "horizon-color": horizonColor,
      "fog-color": fogColor,
      "sky-horizon-blend": 0.18,
      "horizon-fog-blend": 0.72,
      "fog-ground-blend": 0.42,
      "atmosphere-blend": 0
    });
  }

  #previewDraggedPoint(pointId, latitude, longitude) {
    const previewPoints = this.points.map((point) =>
      point.id === pointId ? { ...point, latitude, longitude } : point
    );
    this.#setSourceData(previewPoints);
  }

  #pointFromEvent(event) {
    return this.#pointFromFeatures(event.features);
  }

  #pointFromFeatures(features = []) {
    const pointId = features.find((feature) => feature.properties?.id)?.properties?.id;
    return this.points.find((point) => point.id === pointId) ?? null;
  }

  #popupHtml(point) {
    return `<strong>${escapeHtml(point.label)}</strong><br /><span>${escapeHtml(
      formatCoordinates(point.latitude, point.longitude)
    )}</span>`;
  }

  #syncPopup() {
    if (!this.popup || !this.popupPointId) {
      return;
    }

    const point = this.points.find((candidate) => candidate.id === this.popupPointId);
    if (!point) {
      this.popup.remove();
      return;
    }

    this.popup.setLngLat([point.longitude, point.latitude]).setHTML(this.#popupHtml(point));
  }

  #pauseRotation() {
    this.userInteracting = true;
    window.clearTimeout(this.resumeTimer);
  }
}
