import { formatCoordinate, formatCoordinates, formatTimestamp } from "../utils/formatters.js?v=0.5.0";

const UTC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
});

function formatUtcTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")} UTC`;
}

function formatSolarCoordinate(value, positive, negative) {
  const direction = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(1)}° ${direction}`;
}

export function getDevicePresence(device, now = Date.now()) {
  if (device.active_request) {
    const labels = {
      pending: "Request queued",
      delivered: "Request delivered",
      locating: "Getting GPS fix"
    };
    return {
      state: "waiting",
      label: labels[device.active_request.status] ?? "Location requested"
    };
  }
  const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
  return now - lastSeen <= 45_000
    ? { state: "online", label: "Connected" }
    : { state: "offline", label: "Offline" };
}

export class UiController {
  constructor() {
    this.appReady = false;
    this.workspaceLocked = true;
    this.renderedPoints = [];
    this.editingPointId = null;
    this.deviceRenderKey = null;
    this.solarLive = true;
    this.elements = {
      form: document.getElementById("point-form"),
      label: document.getElementById("label"),
      latitude: document.getElementById("latitude"),
      longitude: document.getElementById("longitude"),
      color: document.getElementById("color"),
      colorValue: document.getElementById("color-value"),
      status: document.getElementById("status"),
      pointsList: document.getElementById("points-list"),
      pointsCount: document.getElementById("points-count"),
      devicesCount: document.getElementById("devices-count"),
      selectionChip: document.getElementById("selection-chip"),
      rotateToggle: document.getElementById("rotate-toggle"),
      centerCurrentLocation: document.getElementById("center-current-location"),
      zoomIn: document.getElementById("zoom-in"),
      zoomOut: document.getElementById("zoom-out"),
      framePoints: document.getElementById("frame-points"),
      resetView: document.getElementById("reset-view"),
      clearForm: document.getElementById("clear-form"),
      mapTitle: document.getElementById("map-title"),
      editorTitle: document.getElementById("editor-title"),
      editorCopy: document.getElementById("editor-copy"),
      editorMode: document.getElementById("editor-mode"),
      submitPoint: document.getElementById("submit-point"),
      clearAllPoints: document.getElementById("clear-all-points"),
      solarLiveToggle: document.getElementById("solar-live-toggle"),
      solarSimulationControls: document.getElementById("solar-simulation-controls"),
      solarDate: document.getElementById("solar-date"),
      solarTimeSlider: document.getElementById("solar-time-slider"),
      solarTimeOutput: document.getElementById("solar-time-output"),
      solarModeLabel: document.getElementById("solar-mode-label"),
      solarClock: document.getElementById("solar-clock"),
      solarPosition: document.getElementById("solar-position"),
      solarNow: document.getElementById("solar-now"),
      trackingUnlockForm: document.getElementById("tracking-unlock-form"),
      trackingToken: document.getElementById("tracking-token"),
      trackingUnlock: document.getElementById("tracking-unlock"),
      trackingControls: document.getElementById("tracking-controls"),
      trackingLock: document.getElementById("tracking-lock"),
      trackingConnectionBadge: document.getElementById("tracking-connection-badge"),
      pairDeviceForm: document.getElementById("pair-device-form"),
      pairDeviceName: document.getElementById("pair-device-name"),
      createPairingCode: document.getElementById("create-pairing-code"),
      pairingCodeCard: document.getElementById("pairing-code-card"),
      pairingCode: document.getElementById("pairing-code"),
      pairingCodeExpiry: document.getElementById("pairing-code-expiry"),
      copyPairingCode: document.getElementById("copy-pairing-code"),
      trackingStatus: document.getElementById("tracking-status"),
      devicesList: document.getElementById("devices-list"),
      apkAvailability: document.getElementById("apk-availability"),
      apkDownload: document.getElementById("apk-download")
    };
    this.#syncColorValue();
    document.getElementById("point-search").addEventListener("input", () => {
      this.renderPoints(this.renderedPoints, this.editingPointId);
    });
    document.getElementById("retry-map").addEventListener("click", () => window.location.reload());
  }

  bind({
    onSubmit,
    onEditPoint,
    onRemovePoint,
    onRotationToggle,
    onCenterCurrentLocation,
    onZoomIn,
    onZoomOut,
    onFramePoints,
    onResetView,
    onClearForm,
    onClearAllPoints,
    onSolarLiveToggle,
    onSolarSimulationChange,
    onSolarNow,
    onUnlockTracking,
    onLockTracking,
    onCreatePairingCode,
    onCopyPairingCode,
    onRequestDeviceLocation,
    onShowDevice,
    onRemoveDevice
  }) {
    this.elements.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (this.elements.form.getAttribute("aria-busy") === "true") {
        return;
      }

      this.setFormBusy(true);
      try {
        await onSubmit(this.getFormPayload());
      } finally {
        this.setFormBusy(false);
      }
    });

    this.elements.pointsList.addEventListener("click", async (event) => {
      const actionButton = event.target.closest("button[data-action]");
      if (!actionButton) {
        return;
      }

      const pointId = actionButton.dataset.pointId;
      if (!pointId) {
        return;
      }

      actionButton.disabled = true;
      try {
        if (actionButton.dataset.action === "edit") {
          await onEditPoint(pointId);
        }

        if (actionButton.dataset.action === "remove") {
          await onRemovePoint(pointId);
        }
      } finally {
        if (actionButton.isConnected) {
          actionButton.disabled = false;
        }
      }
    });

    this.elements.rotateToggle.addEventListener("change", () => {
      onRotationToggle(this.elements.rotateToggle.checked);
    });
    this.elements.centerCurrentLocation.addEventListener("click", onCenterCurrentLocation);
    this.elements.zoomIn.addEventListener("click", onZoomIn);
    this.elements.zoomOut.addEventListener("click", onZoomOut);
    this.elements.framePoints.addEventListener("click", onFramePoints);
    this.elements.resetView.addEventListener("click", onResetView);
    this.elements.clearForm.addEventListener("click", onClearForm);
    this.elements.clearAllPoints.addEventListener("click", async () => {
      this.elements.clearAllPoints.disabled = true;
      try {
        await onClearAllPoints();
      } finally {
        this.elements.clearAllPoints.disabled = Number(this.elements.pointsCount.textContent) === 0;
      }
    });
    this.elements.color.addEventListener("input", () => this.#syncColorValue());
    this.elements.solarLiveToggle.addEventListener("change", () => {
      this.solarLive = this.elements.solarLiveToggle.checked;
      this.#syncSolarControlState();
      onSolarLiveToggle(this.solarLive);
    });
    this.elements.solarDate.addEventListener("change", onSolarSimulationChange);
    this.elements.solarTimeSlider.addEventListener("input", () => {
      this.#syncSolarTimeOutput();
      onSolarSimulationChange();
    });
    this.elements.solarNow.addEventListener("click", onSolarNow);
    this.elements.trackingUnlockForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      this.elements.trackingUnlock.disabled = true;
      this.elements.trackingUnlock.textContent = "Unlocking…";
      try {
        await onUnlockTracking(this.elements.trackingToken.value);
      } finally {
        this.elements.trackingUnlock.disabled = false;
        this.elements.trackingUnlock.textContent = "Unlock workspace";
      }
    });
    this.elements.trackingLock.addEventListener("click", onLockTracking);
    this.elements.pairDeviceForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      this.elements.createPairingCode.disabled = true;
      this.elements.createPairingCode.textContent = "Creating…";
      try {
        await onCreatePairingCode(this.elements.pairDeviceName.value.trim());
      } finally {
        this.elements.createPairingCode.disabled = false;
        this.elements.createPairingCode.textContent = "Create pairing code";
      }
    });
    this.elements.copyPairingCode.addEventListener("click", async () => {
      const code = this.elements.pairingCode.textContent.trim();
      if (code && code !== "—") {
        await onCopyPairingCode(code);
      }
    });
    this.elements.devicesList.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action][data-device-id]");
      if (!button) {
        return;
      }
      button.disabled = true;
      try {
        if (button.dataset.action === "locate") {
          await onRequestDeviceLocation(button.dataset.deviceId);
        }
        if (button.dataset.action === "show") {
          await onShowDevice(button.dataset.deviceId);
        }
        if (button.dataset.action === "remove") {
          await onRemoveDevice(button.dataset.deviceId);
        }
      } finally {
        if (button.isConnected) {
          button.disabled = false;
        }
      }
    });
  }

  getFormPayload(overrides = {}) {
    return {
      label: (overrides.label ?? this.elements.label.value).trim(),
      latitude: Number(overrides.latitude ?? this.elements.latitude.value),
      longitude: Number(overrides.longitude ?? this.elements.longitude.value),
      color: overrides.color ?? this.elements.color.value
    };
  }

  prefillCoordinates({ latitude, longitude }) {
    this.elements.latitude.value = formatCoordinate(latitude);
    this.elements.longitude.value = formatCoordinate(longitude);
    this.setSelectionChip(`Selected ${formatCoordinates(latitude, longitude)}`);
  }

  enterEditMode(point) {
    this.elements.label.value = point.label;
    this.elements.latitude.value = formatCoordinate(point.latitude);
    this.elements.longitude.value = formatCoordinate(point.longitude);
    this.elements.color.value = point.color;
    this.#syncColorValue();
    this.setSelectionChip(`Editing ${point.label} · ${formatCoordinates(point.latitude, point.longitude)}`);
    this.elements.editorTitle.textContent = "Edit Point";
    this.elements.editorCopy.textContent = "Update the form or drag the point on the globe. Save changes when you are ready, or cancel to return to create mode.";
    this.elements.editorMode.textContent = `Editing ${point.label}`;
    this.elements.editorMode.dataset.mode = "editing";
    this.elements.submitPoint.textContent = "Update point";
    this.elements.clearForm.textContent = "Cancel edit";
  }

  exitEditMode(defaultColor) {
    this.elements.form.reset();
    this.elements.color.value = defaultColor;
    this.#syncColorValue();
    this.setSelectionChip("No coordinate selected");
    this.elements.editorTitle.textContent = "Add Point";
    this.elements.editorCopy.textContent = "Choose a spot on the globe or enter coordinates, then save it here.";
    this.elements.editorMode.textContent = "Create mode";
    this.elements.editorMode.dataset.mode = "create";
    this.elements.submitPoint.textContent = "Save point";
    this.elements.clearForm.textContent = "Clear";
  }

  renderPoints(points, editingPointId = null) {
    this.renderedPoints = points;
    this.editingPointId = editingPointId;
    const query = document.getElementById("point-search").value.trim().toLocaleLowerCase();
    const filtered = points.filter((point) => point.label.toLocaleLowerCase().includes(query));
    document.getElementById("search-summary").textContent = this.workspaceLocked ? "Unlock to view saved points." : `${filtered.length} of ${points.length} points`;

    this.elements.pointsCount.textContent = String(points.length);
    this.elements.clearAllPoints.disabled = this.workspaceLocked || points.length === 0;

    if (filtered.length === 0) {
      this.elements.pointsList.innerHTML =
        '<li class="empty-state">No saved points yet. Add one from the form or Shift-click on the globe.</li>';
      this.elements.pointsList.firstElementChild.textContent = this.workspaceLocked
        ? "Your saved points are private. Unlock the workspace to see them."
        : query ? "No matching points. Try a different label." : "No saved points yet. Add your first location above.";
      return;
    }

    this.elements.pointsList.innerHTML = "";

    const fragment = document.createDocumentFragment();
    filtered.forEach((point) => {
      const item = document.createElement("li");
      item.className = `point-card${editingPointId === point.id ? " point-card--active" : ""}`;

      const main = document.createElement("div");
      main.className = "point-card__main";

      const title = document.createElement("h3");
      title.className = "point-card__title";

      const swatch = document.createElement("span");
      swatch.className = "point-card__swatch";
      swatch.style.background = point.color;

      const labelWrap = document.createElement("span");
      labelWrap.className = "point-card__label-wrap";

      const label = document.createElement("span");
      label.textContent = point.label;
      labelWrap.append(label);

      if (editingPointId === point.id) {
        const badge = document.createElement("span");
        badge.className = "point-card__badge";
        badge.textContent = "Editing";
        labelWrap.append(badge);
      }

      title.append(swatch, labelWrap);

      const meta = document.createElement("div");
      meta.className = "point-meta";

      const coords = document.createElement("div");
      coords.textContent = formatCoordinates(point.latitude, point.longitude);

      const created = document.createElement("div");
      created.textContent = `Saved ${formatTimestamp(point.created_at)}`;

      meta.append(coords, created);
      main.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "point-card__actions";

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "point-card__edit";
      editButton.dataset.action = "edit";
      editButton.dataset.pointId = point.id;
      editButton.textContent = editingPointId === point.id ? "Editing" : "Edit";
      editButton.setAttribute("aria-label", `Edit ${point.label}`);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "point-card__remove";
      removeButton.dataset.action = "remove";
      removeButton.dataset.pointId = point.id;
      removeButton.textContent = "Remove";
      removeButton.setAttribute("aria-label", `Remove ${point.label}`);

      actions.append(editButton, removeButton);
      item.append(main, actions);
      fragment.append(item);
    });
    this.elements.pointsList.append(fragment);
  }

  setTrackingLocked(locked) {
    this.workspaceLocked = locked;
    document.getElementById("access-panel").dataset.unlocked = String(!locked);
    document.getElementById("workspace-session").hidden = locked;
    document.getElementById("devices-locked-note").hidden = !locked;
    this.elements.trackingToken.value = "";
    this.elements.trackingLock.hidden = locked;
    this.deviceRenderKey = null;
    this.setFormBusy(false);
    this.renderPoints(this.renderedPoints, this.editingPointId);
    this.elements.trackingUnlockForm.hidden = !locked;
    this.elements.trackingControls.hidden = locked;
    this.elements.devicesCount.textContent = locked ? "—" : this.elements.devicesCount.textContent;
    if (locked) {
      document.getElementById("point-search").value = "";
      this.elements.pairDeviceName.value = "";
      this.elements.trackingStatus.textContent = "";
      this.elements.trackingToken.value = "";
      this.elements.devicesList.innerHTML = "";
      this.elements.pairingCodeCard.hidden = true;
      this.elements.pairingCode.textContent = "—";
      this.elements.pairingCodeExpiry.textContent = "";
    }
  }

  setTrackingConnection({ connected, message }) {
    this.elements.trackingConnectionBadge.dataset.state = connected ? "connected" : "error";
    this.elements.trackingConnectionBadge.textContent = message;
  }

  setTrackingStatus(message, tone = "info") {
    this.elements.trackingStatus.dataset.tone = tone;
    this.elements.trackingStatus.textContent = message;
  }

  setApkAvailable(available) {
    this.elements.apkDownload.hidden = !available;
    this.elements.apkAvailability.textContent = available
      ? "Signed development APK ready to install"
      : "Build the APK to enable this download";
  }

  showPairingCode(pairing) {
    this.elements.pairingCode.textContent = pairing.code;
    this.elements.pairingCodeExpiry.textContent = `Valid until ${formatTimestamp(pairing.expires_at)}`;
    this.elements.pairingCodeCard.hidden = false;
  }

  renderDevices(devices) {
    const renderKey = JSON.stringify(devices.map((device) => ({ ...device, presence: getDevicePresence(device) })));
    if (renderKey === this.deviceRenderKey) return;
    this.deviceRenderKey = renderKey;
    this.elements.devicesCount.textContent = String(devices.length);
    this.elements.devicesList.innerHTML = "";

    if (devices.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "No Android devices paired yet. Create a pairing code to add one.";
      this.elements.devicesList.append(empty);
      return;
    }

    devices.forEach((device) => {
      const presence = getDevicePresence(device);
      const item = document.createElement("li");
      item.className = "device-card";

      const header = document.createElement("div");
      header.className = "device-card__header";
      const title = document.createElement("h3");
      title.textContent = device.name;
      const state = document.createElement("span");
      state.className = "device-card__state";
      state.dataset.state = presence.state;
      state.textContent = presence.label;
      header.append(title, state);

      const meta = document.createElement("div");
      meta.className = "device-card__meta";
      const system = document.createElement("span");
      system.textContent = `${device.platform_version} · App ${device.app_version}`;
      const seen = document.createElement("span");
      seen.textContent = device.last_seen_at ? `Last connection ${formatTimestamp(device.last_seen_at)}` : "Never connected";
      const location = document.createElement("span");
      location.textContent = device.latest_location
        ? `${formatCoordinates(device.latest_location.latitude, device.latest_location.longitude)} · ±${Math.round(
            device.latest_location.accuracy
          )} m · ${formatTimestamp(device.latest_location.captured_at)}${
            device.latest_location.source === "cached" ? " · cached" : ""
          }`
        : "No location received yet";
      meta.append(system, seen);
      if (!device.active_request && device.latest_request?.error) {
        const failure = document.createElement("div");
        failure.className = "device-card__failure";
        failure.textContent = device.latest_request.error;
        meta.append(failure);
      }
      if (device.active_request) {
        const request = document.createElement("span");
        request.className = "device-card__request";
        request.textContent = `${presence.label} · requested ${formatTimestamp(device.active_request.created_at)}`;
        meta.append(request);
      }
      meta.append(location);

      const actions = document.createElement("div");
      actions.className = "device-card__actions";
      const locate = this.#deviceActionButton(
        "locate",
        device.id,
        device.active_request ? "Locating…" : "Request location",
        "device-card__locate"
      );
      locate.disabled = Boolean(device.active_request);
      const show = this.#deviceActionButton("show", device.id, "Show on globe", "button-muted");
      show.disabled = !device.latest_location;
      const remove = this.#deviceActionButton("remove", device.id, "Unpair", "button-danger device-card__remove");
      actions.append(locate, show, remove);
      item.append(header, meta, actions);
      this.elements.devicesList.append(item);
    });
  }

  setStatus(message, tone = "info") {
    this.elements.status.dataset.tone = tone;
    this.elements.status.textContent = message;
  }

  setMapTitle(title) {
    this.elements.mapTitle.textContent = title;
  }

  setSelectionChip(value) {
    this.elements.selectionChip.textContent = value;
  }

  getSolarSimulationDate() {
    const dateValue = this.elements.solarDate.value;
    const minutes = Number(this.elements.solarTimeSlider.value);
    if (!dateValue || !Number.isFinite(minutes)) {
      return null;
    }

    const midnight = new Date(`${dateValue}T00:00:00.000Z`);
    if (Number.isNaN(midnight.getTime())) {
      return null;
    }
    return new Date(midnight.getTime() + minutes * 60_000);
  }

  setSolarState({ date, position, live }) {
    this.solarLive = live;
    this.elements.solarLiveToggle.checked = live;
    this.elements.solarModeLabel.textContent = live ? "Live solar time" : "Simulated solar time";
    this.elements.solarModeLabel.dataset.mode = live ? "live" : "simulation";
    this.elements.solarClock.dateTime = date.toISOString();
    this.elements.solarClock.textContent = `${UTC_DATE_TIME_FORMATTER.format(date)} UTC`;
    this.elements.solarPosition.textContent = `Sun over ${formatSolarCoordinate(
      position.latitude,
      "N",
      "S"
    )} · ${formatSolarCoordinate(position.longitude, "E", "W")}`;
    this.elements.solarDate.value = date.toISOString().slice(0, 10);
    this.elements.solarTimeSlider.value = String(date.getUTCHours() * 60 + date.getUTCMinutes());
    this.#syncSolarTimeOutput();
    this.#syncSolarControlState();
  }

  setAppReady(ready) {
    this.appReady = ready;
    [
      this.elements.rotateToggle,
      this.elements.centerCurrentLocation,
      this.elements.zoomIn,
      this.elements.zoomOut,
      this.elements.framePoints,
      this.elements.resetView,
      this.elements.label,
      this.elements.latitude,
      this.elements.longitude,
      this.elements.color,
      this.elements.submitPoint,
      this.elements.clearForm,
      this.elements.solarLiveToggle
    ].forEach((control) => {
      control.disabled = !ready;
    });
    this.elements.clearAllPoints.disabled = !ready || Number(this.elements.pointsCount.textContent) === 0;
    this.#syncSolarControlState();
    this.setFormBusy(false);
  }

  setFormBusy(busy) {
    this.elements.form.setAttribute("aria-busy", String(busy));
    Array.from(this.elements.form.elements).forEach((control) => {
      control.disabled = busy || this.workspaceLocked;
    });
    this.elements.submitPoint.textContent = busy
      ? "Saving…"
      : this.elements.editorMode.dataset.mode === "editing"
        ? "Update point"
        : "Save point";
  }

  setCurrentLocationButtonState({
    disabled = false,
    busy = false,
    available = false,
    failed = false,
    message = ""
  } = {}) {
    this.elements.centerCurrentLocation.disabled = disabled || busy;
    this.elements.centerCurrentLocation.textContent = busy
      ? "Locating…"
      : available
        ? "Center on my location"
        : disabled
          ? "Location unavailable"
          : failed
            ? "Try location again"
            : "Find my location";
    this.elements.centerCurrentLocation.title = message;
  }

  #syncColorValue() {
    this.elements.colorValue.value = this.elements.color.value.toUpperCase();
  }

  #deviceActionButton(action, deviceId, label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.dataset.deviceId = deviceId;
    button.className = className;
    button.textContent = label;
    return button;
  }

  #syncSolarControlState() {
    const simulationDisabled = !this.appReady || this.solarLive;
    this.elements.solarLiveToggle.disabled = !this.appReady;
    this.elements.solarDate.disabled = simulationDisabled;
    this.elements.solarTimeSlider.disabled = simulationDisabled;
    this.elements.solarNow.disabled = simulationDisabled;
    this.elements.solarSimulationControls.dataset.disabled = String(simulationDisabled);
  }

  #syncSolarTimeOutput() {
    this.elements.solarTimeOutput.value = formatUtcTime(Number(this.elements.solarTimeSlider.value));
  }
}
