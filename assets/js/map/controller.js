import { escapeHtml, formatCoordinates, normalizeCoordinates, normalizeLongitude } from "../utils/formatters.js";
import { currentLocationToFeatureCollection, emptyFeatureCollection, pointsToFeatureCollection } from "./geojson.js";
import {
  drawSolarTexture,
  getSolarElevation,
  getSolarPosition,
  SOLAR_TEXTURE_HEIGHT,
  SOLAR_TEXTURE_WIDTH
} from "./solar.js";

const SOURCE_ID = "points";
const HALO_LAYER_ID = "points-halo";
const CORE_LAYER_ID = "points-core";
const LABEL_LAYER_ID = "points-labels";
const INTERACTIVE_LAYERS = [CORE_LAYER_ID, LABEL_LAYER_ID];
const CURRENT_LOCATION_SOURCE_ID = "current-location";
const CURRENT_LOCATION_HALO_LAYER_ID = "current-location-halo";
const CURRENT_LOCATION_CORE_LAYER_ID = "current-location-core";
const CURRENT_LOCATION_LABEL_LAYER_ID = "current-location-label";
const SOLAR_SOURCE_ID = "solar-illumination";
const SOLAR_SHADE_LAYER_ID = "solar-shade";
const SOLAR_CANVAS_ID = "solar-illumination-canvas";
const MERCATOR_MAX_LATITUDE = 85.05112878;

function interpolateColor(from, to, amount) {
  const safeAmount = Math.min(1, Math.max(0, amount));
  const channel = (start, end) => Math.round(start + (end - start) * safeAmount);
  const fromChannels = from.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16));
  const toChannels = to.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16));
  return `rgb(${fromChannels.map((value, index) => channel(value, toChannels[index])).join(", ")})`;
}

function smoothStep(minimum, maximum, value) {
  const position = Math.min(1, Math.max(0, (value - minimum) / (maximum - minimum)));
  return position * position * (3 - 2 * position);
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
    this.rotationTimer = null;
    this.resumeTimer = null;
    this.popup = null;
    this.popupPointId = null;
    this.dragState = null;
    this.suppressNextMapClick = false;
    this.currentLocation = null;
    this.solarPosition = getSolarPosition();
    this.solarCanvas = null;
    this.solarTextureFrame = null;
  }

  async mount(config) {
    if (!window.maplibregl) {
      throw new Error("MapLibre GL JS failed to load.");
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
      this.map.once("load", resolve);
      this.map.once("error", (event) => reject(event.error ?? new Error("Map failed to load")));
    });

    this.#installSolarLayers();
    this.#installPointLayers();
    this.#installCurrentLocationLayers();
    this.#bindMapInteractions();
    this.#updateAtmosphere();
    this.startRotation();
  }

  setPoints(points) {
    this.points = points;
    this.#setSourceData(points);
    this.#syncPopup();
  }

  setRotationEnabled(enabled) {
    this.rotationEnabled = enabled;
  }

  setCurrentLocation(location) {
    this.currentLocation = location;
    this.#setCurrentLocationData(location);
  }

  setSolarDate(value) {
    this.solarPosition = getSolarPosition(value);
    this.#updateSolarTexture();
    this.#updateAtmosphere();
    return this.solarPosition;
  }

  zoomIn() {
    this.map?.easeTo({ zoom: this.map.getZoom() + 0.55, duration: 350 });
  }

  zoomOut() {
    this.map?.easeTo({ zoom: this.map.getZoom() - 0.55, duration: 350 });
  }

  resetView() {
    if (!this.map || !this.defaultView) {
      return;
    }

    this.map.easeTo({
      center: [this.defaultView.longitude, this.defaultView.latitude],
      zoom: this.defaultView.zoom,
      bearing: this.defaultView.bearing,
      pitch: this.defaultView.pitch,
      duration: 900
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
      essential: true
    });

    this.popup?.remove();
    this.popupPointId = point.id;
    this.popup = new window.maplibregl.Popup({ offset: 18 })
      .setLngLat([point.longitude, point.latitude])
      .setHTML(this.#popupHtml(point))
      .addTo(this.map);
    this.popup.on("close", () => {
      this.popup = null;
      this.popupPointId = null;
    });
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
      essential: true
    });
    return true;
  }

  startRotation() {
    window.clearTimeout(this.rotationTimer);

    const tick = () => {
      if (!this.map) {
        return;
      }

      if (this.rotationEnabled && !this.userInteracting && !this.dragState && this.map.getZoom() <= this.rotationMaxZoom) {
        const center = this.map.getCenter();
        const zoomFactor = (this.rotationMaxZoom - this.map.getZoom()) / this.rotationMaxZoom;
        const distancePerTick = (this.rotationDegreesPerSecond * Math.max(zoomFactor, 0.2)) / 2;

        this.map.easeTo({
          center: [center.lng - distancePerTick, center.lat],
          duration: 450,
          easing: (value) => value
        });
      }

      this.rotationTimer = window.setTimeout(tick, 550);
    };

    tick();
  }

  destroy() {
    window.clearTimeout(this.rotationTimer);
    window.clearTimeout(this.resumeTimer);
    window.cancelAnimationFrame(this.solarTextureFrame);
    this.popup?.remove();
    this.map?.remove();
    this.solarCanvas?.remove();
  }

  #installSolarLayers() {
    document.getElementById(SOLAR_CANVAS_ID)?.remove();
    this.solarCanvas = document.createElement("canvas");
    this.solarCanvas.id = SOLAR_CANVAS_ID;
    this.solarCanvas.width = SOLAR_TEXTURE_WIDTH;
    this.solarCanvas.height = SOLAR_TEXTURE_HEIGHT;
    this.solarCanvas.hidden = true;
    document.body.append(this.solarCanvas);
    drawSolarTexture(this.solarCanvas, this.solarPosition);

    this.map.addSource(SOLAR_SOURCE_ID, {
      type: "canvas",
      canvas: SOLAR_CANVAS_ID,
      animate: false,
      coordinates: [
        [-180, MERCATOR_MAX_LATITUDE],
        [180, MERCATOR_MAX_LATITUDE],
        [180, -MERCATOR_MAX_LATITUDE],
        [-180, -MERCATOR_MAX_LATITUDE]
      ]
    });

    const firstSymbolLayer = this.map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
    this.map.addLayer(
      {
        id: SOLAR_SHADE_LAYER_ID,
        type: "raster",
        source: SOLAR_SOURCE_ID,
        paint: {
          "raster-opacity": 1,
          "raster-fade-duration": 0,
          "raster-resampling": "linear"
        }
      },
      firstSymbolLayer
    );
  }

  #updateSolarTexture() {
    if (!this.solarCanvas) {
      return;
    }

    drawSolarTexture(this.solarCanvas, this.solarPosition);
    const source = this.map?.getSource(SOLAR_SOURCE_ID);
    if (!source || typeof source.play !== "function") {
      this.map?.triggerRepaint();
      return;
    }

    window.cancelAnimationFrame(this.solarTextureFrame);
    source.play();
    this.map.triggerRepaint();
    this.solarTextureFrame = window.requestAnimationFrame(() => source.pause());
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
      this.#updateAtmosphere();
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

  #updateAtmosphere() {
    if (!this.map || !this.solarPosition) {
      return;
    }

    const center = this.map.getCenter();
    const solarElevation = getSolarElevation(this.solarPosition, center.lat, center.lng);
    const daylight = smoothStep(-12, 6, solarElevation);
    const horizonColor = interpolateColor("#071225", "#8ec9de", daylight);
    const fogColor = interpolateColor("#07101e", "#c4e3e9", daylight);

    if (typeof this.map.setSky === "function") {
      this.map.setSky({
        "sky-color": "#020711",
        "horizon-color": horizonColor,
        "fog-color": fogColor,
        "sky-horizon-blend": 0.18,
        "horizon-fog-blend": 0.72,
        "fog-ground-blend": 0.42,
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0]
      });
      return;
    }

    if (typeof this.map.setFog === "function") {
      this.map.setFog({
        color: fogColor,
        "high-color": horizonColor,
        "horizon-blend": 0.14,
        "space-color": "#020711",
        "star-intensity": 0.45 - daylight * 0.37
      });
    }
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
