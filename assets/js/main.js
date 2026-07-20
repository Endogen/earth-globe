import { ApiClient } from "./api/client.js";
import { LocationService } from "./location/service.js";
import { MapController } from "./map/controller.js";
import { PointsStore } from "./state/points-store.js";
import { UiController } from "./ui/controller.js";
import { formatCoordinates } from "./utils/formatters.js";

const apiClient = new ApiClient();
const locationService = new LocationService();
const ui = new UiController();
const pointsStore = new PointsStore(apiClient);
ui.setAppReady(false);

let appConfig = null;
let currentPoints = [];
let editingPointId = null;
let currentLocation = null;
let solarLive = true;
let solarTimer = null;

const mapController = new MapController({
  containerId: "map",
  onCoordinatePick: ({ latitude, longitude }) => {
    ui.prefillCoordinates({ latitude, longitude });
    ui.setStatus(`Coordinates selected: ${formatCoordinates(latitude, longitude)}. Review the form and save when ready.`);
  },
  onQuickAddRequest: async ({ latitude, longitude }) => {
    await createPoint(buildQuickAddPayload(latitude, longitude), `Point saved from the globe at ${formatCoordinates(latitude, longitude)}.`);
  },
  onPointSelect: (point) => {
    enterEditMode(point, true);
  },
  onPointMoveRequest: async ({ pointId, latitude, longitude }) => {
    await movePoint(pointId, latitude, longitude);
  },
  onPointRemoveRequest: async (pointId) => {
    await removePoint(pointId, "Removed point from the globe:");
  }
});

pointsStore.subscribe((points) => {
  currentPoints = points;
  ui.renderPoints(points, editingPointId);
  if (mapController.map) {
    mapController.setPoints(points);
  }
});

ui.bind({
  onSubmit: async (payload) => {
    if (editingPointId) {
      await updatePoint(editingPointId, payload);
      return;
    }

    await createPoint(payload, `Point saved at ${formatCoordinates(payload.latitude, payload.longitude)}.`);
  },
  onEditPoint: (pointId) => {
    const point = currentPoints.find((item) => item.id === pointId);
    if (!point) {
      ui.setStatus("The selected point no longer exists.", "error");
      return;
    }

    enterEditMode(point, true);
  },
  onRemovePoint: async (pointId) => {
    await removePoint(pointId, "Removed point from the list:");
  },
  onRotationToggle: (enabled) => {
    mapController.setRotationEnabled(enabled);
    ui.setStatus(enabled ? "Auto-rotate enabled." : "Auto-rotate disabled.");
  },
  onCenterCurrentLocation: async () => {
    await centerOnCurrentLocation();
  },
  onZoomIn: () => mapController.zoomIn(),
  onZoomOut: () => mapController.zoomOut(),
  onFramePoints: () => {
    mapController.framePoints(currentPoints);
    ui.setStatus(currentPoints.length ? "Framed saved points on the globe." : "Add a point before framing the globe.");
  },
  onResetView: () => {
    mapController.resetView();
    ui.setStatus("Reset the camera to the default global view.");
  },
  onClearForm: () => {
    exitEditMode();
    ui.setStatus("Returned to create mode.");
  },
  onClearAllPoints: async () => {
    await clearAllPoints();
  },
  onSolarLiveToggle: (enabled) => {
    setSolarLive(enabled);
    ui.setStatus(
      enabled
        ? "Following the current Sun position and updating once a minute."
        : "Solar simulation enabled. Choose a UTC date and time to move the terminator."
    );
  },
  onSolarSimulationChange: () => {
    if (!solarLive) {
      updateSolarCycle(ui.getSolarSimulationDate());
    }
  },
  onSolarNow: () => {
    setSolarLive(true);
    ui.setStatus("Returned to the live astronomical day and night cycle.", "success");
  }
});

bootstrap().catch((error) => {
  console.error(error);
  ui.setStatus(error.message || "The app failed to start.", "error");
});

async function bootstrap() {
  ui.setStatus("Loading configuration and points…");
  [appConfig] = await Promise.all([apiClient.getConfig(), pointsStore.load()]);

  const prefersReducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const mapConfig = {
    ...appConfig,
    rotation: {
      ...appConfig.rotation,
      enabled: appConfig.rotation.enabled && !prefersReducedMotion
    }
  };

  ui.setMapTitle(`${appConfig.app_title} · Globe`);
  ui.exitEditMode(appConfig.default_point_color);
  ui.elements.rotateToggle.checked = mapConfig.rotation.enabled;

  await mapController.mount(mapConfig);
  mapController.setPoints(currentPoints);
  setSolarLive(true);
  bindLocationUpdates();
  ui.setAppReady(true);
  ui.setCurrentLocationButtonState({
    disabled: !locationService.isSupported() || !locationService.isSecureContext(),
    available: false,
    message: getLocationUnavailableMessage()
  });

  ui.setStatus(
    prefersReducedMotion
      ? "Map ready. Auto-rotate is paused to respect your reduced-motion preference."
      : "Map ready. Select a coordinate or add a saved point to begin.",
    "success"
  );
}

function updateSolarCycle(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    ui.setStatus("Choose a valid UTC date and time for the solar simulation.", "error");
    return;
  }

  const position = mapController.setSolarDate(date);
  ui.setSolarState({ date: position.date, position, live: solarLive });
}

function setSolarLive(enabled) {
  solarLive = enabled;
  window.clearTimeout(solarTimer);

  if (!enabled) {
    updateSolarCycle(ui.getSolarSimulationDate() ?? new Date());
    return;
  }

  updateSolarCycle(new Date());
  scheduleSolarUpdate();
}

function scheduleSolarUpdate() {
  const millisecondsUntilNextMinute = 60_000 - (Date.now() % 60_000) + 50;
  solarTimer = window.setTimeout(() => {
    if (!solarLive) {
      return;
    }
    updateSolarCycle(new Date());
    scheduleSolarUpdate();
  }, millisecondsUntilNextMinute);
}

function validatePayload(payload) {
  if (!payload.label || Number.isNaN(payload.latitude) || Number.isNaN(payload.longitude)) {
    ui.setStatus("Label, latitude, and longitude are required.", "error");
    return false;
  }

  if (payload.latitude < -90 || payload.latitude > 90 || payload.longitude < -180 || payload.longitude > 180) {
    ui.setStatus("Latitude must be between -90 and 90, and longitude between -180 and 180.", "error");
    return false;
  }

  return true;
}

async function createPoint(payload, successMessage) {
  if (!validatePayload(payload)) {
    return;
  }

  try {
    const point = await pointsStore.add(payload);
    exitEditMode();
    ui.prefillCoordinates({ latitude: point.latitude, longitude: point.longitude });
    ui.setStatus(successMessage, "success");
  } catch (error) {
    ui.setStatus(error.message || "The point could not be saved.", "error");
  }
}

async function updatePoint(pointId, payload) {
  if (!validatePayload(payload)) {
    return;
  }

  try {
    const point = await pointsStore.update(pointId, payload);
    enterEditMode(point, false);
    ui.setStatus(`Updated ${point.label} at ${formatCoordinates(point.latitude, point.longitude)}.`, "success");
  } catch (error) {
    ui.setStatus(error.message || "The point could not be updated.", "error");
  }
}

async function movePoint(pointId, latitude, longitude) {
  const point = currentPoints.find((item) => item.id === pointId);
  if (!point) {
    ui.setStatus("The dragged point no longer exists.", "error");
    return;
  }

  try {
    const updated = await pointsStore.update(pointId, {
      label: point.label,
      color: point.color,
      latitude,
      longitude
    });

    if (editingPointId === updated.id) {
      enterEditMode(updated, false);
    } else {
      ui.prefillCoordinates({ latitude: updated.latitude, longitude: updated.longitude });
    }

    ui.setStatus(`Moved ${updated.label} to ${formatCoordinates(updated.latitude, updated.longitude)}.`, "success");
  } catch (error) {
    ui.setStatus(error.message || "The point could not be moved.", "error");
  }
}

function buildQuickAddPayload(latitude, longitude) {
  const draft = ui.getFormPayload();

  return {
    label: draft.label || `Point ${currentPoints.length + 1}`,
    latitude,
    longitude,
    color: draft.color
  };
}

function enterEditMode(point, focusMap) {
  editingPointId = point.id;
  ui.enterEditMode(point);
  ui.renderPoints(currentPoints, editingPointId);
  if (focusMap) {
    mapController.focusPoint(point);
  }
  ui.setStatus(`Editing ${point.label}. Drag the point or update the form, then save your changes.`);
}

function exitEditMode() {
  editingPointId = null;
  ui.exitEditMode(appConfig?.default_point_color ?? "#ff8d57");
  ui.renderPoints(currentPoints, editingPointId);
}

async function removePoint(pointId, successMessage) {
  try {
    const removed = await pointsStore.remove(pointId);
    if (editingPointId === pointId) {
      exitEditMode();
    }
    ui.setStatus(`${successMessage} ${removed.label}.`, "success");
  } catch (error) {
    ui.setStatus(error.message || "The point could not be removed.", "error");
  }
}

function bindLocationUpdates() {
  locationService.addEventListener("locationchange", (event) => {
    currentLocation = event.detail;
    mapController.setCurrentLocation(currentLocation);
    ui.setCurrentLocationButtonState({ available: true });
  });

  locationService.addEventListener("locationerror", (event) => {
    if (!currentLocation) {
      ui.setCurrentLocationButtonState({
        disabled: !locationService.isSupported() || !locationService.isSecureContext(),
        available: false,
        failed: true,
        message: event.detail.message
      });
    }
    console.warn(event.detail);
  });
}

async function startLocationTracking({ reportErrors, showBusy }) {
  try {
    ui.setCurrentLocationButtonState({
      disabled: !locationService.isSupported() || !locationService.isSecureContext(),
      busy: showBusy,
      available: Boolean(currentLocation),
      message: getLocationUnavailableMessage()
    });

    const location = await locationService.ensureTracking();
    currentLocation = location;
    mapController.setCurrentLocation(location);
    ui.setCurrentLocationButtonState({ available: true });
    return location;
  } catch (error) {
    ui.setCurrentLocationButtonState({
      disabled: !locationService.isSupported() || !locationService.isSecureContext(),
      available: false,
      failed: true,
      message: error.message || getLocationUnavailableMessage()
    });
    if (reportErrors) {
      ui.setStatus(error.message || "Current location is unavailable.", "error");
    }
    throw error;
  }
}

async function centerOnCurrentLocation() {
  try {
    const location = await startLocationTracking({ reportErrors: true, showBusy: true });
    const centered = mapController.centerOnCurrentLocation();
    if (!centered) {
      ui.setStatus("Current location is not available yet.", "error");
      return;
    }

    ui.setSelectionChip(`Current location · ${formatCoordinates(location.latitude, location.longitude)}`);
    ui.setStatus(`Centered on current location at ${formatCoordinates(location.latitude, location.longitude)}.`, "success");
  } catch {
    // Errors are surfaced through status updates in startLocationTracking.
  }
}

async function clearAllPoints() {
  if (currentPoints.length === 0) {
    ui.setStatus("There are no saved points to remove.", "error");
    return;
  }

  const confirmed = globalThis.confirm(`Remove all ${currentPoints.length} saved points?`);
  if (!confirmed) {
    return;
  }

  try {
    const result = await pointsStore.clear();
    if (editingPointId) {
      exitEditMode();
    }
    ui.setStatus(`Removed ${result.removed_count} saved point${result.removed_count === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    ui.setStatus(error.message || "The saved points could not be removed.", "error");
  }
}

function getLocationUnavailableMessage() {
  if (!locationService.isSupported()) {
    return "This browser does not expose geolocation.";
  }

  if (!locationService.isSecureContext()) {
    return "Current location requires HTTPS or localhost in the browser.";
  }

  return "";
}

globalThis.addEventListener("beforeunload", () => {
  window.clearTimeout(solarTimer);
  locationService.stopTracking();
  mapController.destroy();
});
