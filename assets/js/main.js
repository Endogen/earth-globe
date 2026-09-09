import { ApiClient } from "./api/client.js?v=0.4.0";
import { LocationService } from "./location/service.js?v=0.4.0";
import { MapController } from "./map/controller.js?v=0.4.0";
import {
  DevicesStore,
  getDeviceRefreshDelay,
  getDeviceRefreshStatus
} from "./state/devices-store.js?v=0.4.0";
import { PointsStore } from "./state/points-store.js?v=0.4.0";
import { UiController } from "./ui/controller.js?v=0.4.0";
import { formatCoordinates } from "./utils/formatters.js?v=0.4.0";

const apiClient = new ApiClient();
const locationService = new LocationService();
const ui = new UiController();
const pointsStore = new PointsStore(apiClient);
const devicesStore = new DevicesStore(apiClient);
// Remove credentials saved by older versions; sessions now use an HttpOnly cookie.
try { globalThis.sessionStorage?.removeItem("earth-globe-tracking-token"); } catch { /* Storage can be blocked. */ }
ui.setAppReady(false);
ui.elements.trackingUnlock.disabled = true;

let appConfig = null;
let currentPoints = [];
let editingPointId = null;
let currentLocation = null;
let currentDevices = [];
let solarLive = true;
let solarTimer = null;
let deviceRefreshTimer = null;
let trackingUnlocked = false;
let accessGeneration = 0;
const accessChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("earth-workspace-access") : null;
accessChannel?.addEventListener("message", () => {
  clearWorkspaceAccess();
  ui.setStatus("Workspace locked in another tab.");
});
apiClient.addEventListener("unauthorized", () => {
  clearWorkspaceAccess();
  ui.setStatus("Your session expired. Unlock the workspace to continue.", "error");
});

const mapController = new MapController({
  containerId: "map",
  onCoordinatePick: ({ latitude, longitude }) => {
    if (!trackingUnlocked) { ui.setStatus("Unlock the workspace to save a location."); return; }
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

devicesStore.subscribe((devices) => {
  currentDevices = devices;
  ui.renderDevices(devices);
  if (mapController.map) {
    mapController.setTrackedDevices(devices);
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
  },
  onUnlockTracking: async (token) => {
    await unlockTracking(token, true);
  },
  onLockTracking: () => {
    return lockTracking();
  },
  onCreatePairingCode: async (deviceName) => {
    await createDevicePairingCode(deviceName);
  },
  onCopyPairingCode: async (pairingCode) => {
    await copyDevicePairingCode(pairingCode);
  },
  onRequestDeviceLocation: async (deviceId) => {
    await requestTrackedDeviceLocation(deviceId);
  },
  onShowDevice: (deviceId) => {
    showTrackedDevice(deviceId);
  },
  onRemoveDevice: async (deviceId) => {
    await removeTrackedDevice(deviceId);
  }
});

bootstrap().catch((error) => {
  console.error(error);
  ui.setStatus(error.message || "The app failed to start.", "error");
});

async function bootstrap() {
  ui.setStatus("Loading your globe…");
  let trackingStatus;
  [appConfig, trackingStatus] = await Promise.all([
    apiClient.getConfig(),
    apiClient.getTrackingStatus()
  ]);

  const prefersReducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const mapConfig = {
    ...appConfig,
    rotation: {
      ...appConfig.rotation,
      enabled: appConfig.rotation.enabled && !prefersReducedMotion
    }
  };

  ui.elements.trackingUnlock.disabled = false;
  ui.setMapTitle(`${appConfig.app_title} · Globe`);
  ui.exitEditMode(appConfig.default_point_color);
  ui.elements.rotateToggle.checked = mapConfig.rotation.enabled;

  ui.setAppReady(true);
  ui.setTrackingLocked(true);
  const mapReady = mapController.mount(mapConfig).then(() => {
    mapController.setPoints(currentPoints);
    mapController.deviceSourceKey = null;
    mapController.setTrackedDevices(currentDevices);
    setSolarLive(true);
  }).catch((error) => {
    ui.setStatus(`Map unavailable: ${error.message}. You can still use the point editor.`, "error");
    document.getElementById("map-error").hidden = false;
  });
  mapController.setPoints(currentPoints);
  mapController.setTrackedDevices(currentDevices);
  bindLocationUpdates();
  ui.setAppReady(true);
  ui.setCurrentLocationButtonState({
    disabled: !locationService.isSupported() || !locationService.isSecureContext(),
    available: false,
    message: getLocationUnavailableMessage()
  });
  ui.setApkAvailable(trackingStatus.apk_available);
  ui.setTrackingLocked(true);
  document.addEventListener("visibilitychange", handleTrackingVisibilityChange);

  try {
    await apiClient.getSession();
    await unlockTracking("", false);
  } catch (error) {
    ui.setStatus(error.status === 401 ? "Explore the globe, or unlock to access saved points and devices." : error.message);
  }
  await mapReady;
}

async function unlockTracking(token, reportError) {
  const generation = ++accessGeneration;
  try {
    if (reportError) await apiClient.unlock(token.trim());
    await Promise.all([devicesStore.load(), pointsStore.load()]);
    if (generation !== accessGeneration) return false;
    trackingUnlocked = true;
    ui.setTrackingLocked(false);
    ui.setTrackingConnection({ connected: true, message: "Workspace unlocked" });
    ui.setTrackingStatus(currentDevices.length ? "Choose a device to request its location." : "Create a pairing code to add your Android phone.");
    ui.setStatus("Workspace unlocked. Your session lasts up to eight hours.", "success");
    scheduleDeviceRefresh();
    return true;
  } catch (error) {
    if (generation === accessGeneration) {
      clearWorkspaceAccess();
      if (reportError) ui.setStatus(error.message || "The workspace could not be unlocked.", "error");
    }
    return false;
  }
}

function clearWorkspaceAccess() {
  accessGeneration += 1;
  trackingUnlocked = false;
  window.clearTimeout(deviceRefreshTimer);
  apiClient.cancelPending();
  devicesStore.clear();
  pointsStore.reset();
  mapController.popup?.remove();
  mapController.resetView({ animate: false });
  locationService.stopTracking();
  currentLocation = null;
  mapController.setCurrentLocation(null);
  ui.setCurrentLocationButtonState({
    disabled: !locationService.isSupported() || !locationService.isSecureContext(),
    available: false,
    message: getLocationUnavailableMessage()
  });
  exitEditMode();
  ui.setTrackingLocked(true);
}

async function lockTracking() {
  clearWorkspaceAccess();
  try {
    await apiClient.lock();
    accessChannel?.postMessage("locked");
    ui.setStatus("Workspace locked. The session has been revoked.");
  } catch (error) {
    ui.setStatus("Data hidden, but the server could not revoke this session. Reconnect and use Lock again.", "error");
    ui.setTrackingConnection({ connected: false, message: "Lock needs retry" });
    document.getElementById("workspace-session").hidden = false;
    ui.elements.trackingLock.hidden = false;
  }
}

function scheduleDeviceRefresh(delay = null) {
  window.clearTimeout(deviceRefreshTimer);
  if (!trackingUnlocked) {
    return;
  }
  const refreshDelay =
    delay ??
    getDeviceRefreshDelay({
      hidden: document.hidden,
      hasActiveRequest: currentDevices.some((device) => device.active_request)
    });
  const generation = accessGeneration;
  deviceRefreshTimer = window.setTimeout(async () => {
    try {
      const previousDeviceCount = currentDevices.length;
      const hadActiveRequest = currentDevices.some((device) => device.active_request);
      await devicesStore.load();
      if (generation !== accessGeneration) return;
      ui.setTrackingConnection({ connected: true, message: "Workspace unlocked" });
      const refreshStatus = getDeviceRefreshStatus({
        hadActiveRequest,
        hasActiveRequest: currentDevices.some((device) => device.active_request),
        previousDeviceCount,
        deviceCount: currentDevices.length
      });
      if (refreshStatus) {
        ui.setTrackingStatus(refreshStatus);
      }
      scheduleDeviceRefresh();
    } catch (error) {
      if (generation !== accessGeneration) return;
      const authenticationFailed = error.status === 401;
      if (authenticationFailed) {
        lockTracking();
        ui.setStatus("The device-tracking control key is no longer valid.", "error");
        return;
      }
      ui.setTrackingConnection({ connected: false, message: "Server connection interrupted" });
      ui.setTrackingStatus("Retrying the device connection automatically…", "error");
      scheduleDeviceRefresh(
        getDeviceRefreshDelay({
          hidden: document.hidden,
          hasActiveRequest: currentDevices.some((device) => device.active_request),
          retrying: true
        })
      );
    }
  }, refreshDelay);
}

function handleTrackingVisibilityChange() {
  if (!document.hidden && solarLive) updateSolarCycle(new Date());
  if (trackingUnlocked) {
    scheduleDeviceRefresh(document.hidden ? null : 0);
  }
}

async function createDevicePairingCode(deviceName) {
  if (!deviceName) {
    ui.setTrackingStatus("Enter a name for the phone before creating a code.", "error");
    return;
  }
  try {
    const pairing = await apiClient.createPairingCode(deviceName);
    ui.showPairingCode(pairing);
    ui.setTrackingStatus("Pairing code created. It can be used once and expires after ten minutes.", "success");
  } catch (error) {
    ui.setTrackingStatus(error.message || "The pairing code could not be created.", "error");
  }
}

async function copyDevicePairingCode(pairingCode) {
  try {
    if (!globalThis.navigator?.clipboard?.writeText) {
      throw new Error("Clipboard access is unavailable in this browser.");
    }
    await globalThis.navigator.clipboard.writeText(pairingCode);
    ui.setTrackingStatus("Pairing code copied. Open Earth Tracker on the phone and paste it there.", "success");
  } catch (error) {
    ui.setTrackingStatus(error.message || "Select the pairing code and copy it manually.", "error");
  }
}

async function requestTrackedDeviceLocation(deviceId) {
  const device = currentDevices.find((item) => item.id === deviceId);
  if (!device) {
    ui.setTrackingStatus("That device is no longer registered.", "error");
    return;
  }
  try {
    await devicesStore.requestLocation(deviceId);
    ui.setTrackingStatus(`Location requested from ${device.name}. Waiting for a fresh GPS fix…`, "success");
    scheduleDeviceRefresh();
  } catch (error) {
    ui.setTrackingStatus(error.message || `Could not request ${device.name}'s location.`, "error");
  }
}

function showTrackedDevice(deviceId) {
  const device = currentDevices.find((item) => item.id === deviceId);
  if (!device?.latest_location || !mapController.focusTrackedDevice(device)) {
    ui.setTrackingStatus("This device has not sent a location yet.", "error");
    return;
  }
  ui.setSelectionChip(
    `${device.name} · ${formatCoordinates(device.latest_location.latitude, device.latest_location.longitude)}`
  );
  ui.setTrackingStatus(`Showing the latest location received from ${device.name}.`, "success");
}

async function removeTrackedDevice(deviceId) {
  const device = currentDevices.find((item) => item.id === deviceId);
  if (!device || !globalThis.confirm(`Unpair ${device.name} and delete its stored location history?`)) {
    return;
  }
  try {
    await devicesStore.remove(deviceId);
    ui.setTrackingStatus(`${device.name} was unpaired and its device credential was revoked.`, "success");
  } catch (error) {
    ui.setTrackingStatus(error.message || `${device.name} could not be unpaired.`, "error");
  }
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
    if (!document.hidden) updateSolarCycle(new Date());
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
  if (!trackingUnlocked) { ui.setStatus("Unlock the workspace to save a location."); return; }
  if (!validatePayload(payload)) {
    return;
  }

  try {
    const point = await pointsStore.add(payload);
    if (!point || !trackingUnlocked) return;
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
    if (!point || !trackingUnlocked) return;
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

    if (!updated || !trackingUnlocked) return;
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
  ui.elements.label.focus();
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
    if (!removed || !trackingUnlocked) return;
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
  const generation = accessGeneration;
  try {
    ui.setCurrentLocationButtonState({
      disabled: !locationService.isSupported() || !locationService.isSecureContext(),
      busy: showBusy,
      available: Boolean(currentLocation),
      message: getLocationUnavailableMessage()
    });

    const location = await locationService.ensureTracking();
    if (generation !== accessGeneration) return null;
    currentLocation = location;
    mapController.setCurrentLocation(location);
    ui.setCurrentLocationButtonState({ available: true });
    return location;
  } catch (error) {
    if (generation !== accessGeneration) return null;
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
    if (!location) return;
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
    if (!result || !trackingUnlocked) return;
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
  window.clearTimeout(deviceRefreshTimer);
  document.removeEventListener("visibilitychange", handleTrackingVisibilityChange);
  locationService.stopTracking();
  mapController.destroy();
});
