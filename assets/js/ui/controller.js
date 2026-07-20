import { formatCoordinate, formatCoordinates, formatTimestamp } from "../utils/formatters.js";

export class UiController {
  constructor() {
    this.appReady = false;
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
      clearAllPoints: document.getElementById("clear-all-points")
    };
    this.#syncColorValue();
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
    onClearAllPoints
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
    this.elements.editorCopy.textContent = "Click the globe to prefill coordinates. Shift-click creates instantly. Click a point to edit it, drag it to move it, and Alt-click to remove it.";
    this.elements.editorMode.textContent = "Create mode";
    this.elements.editorMode.dataset.mode = "create";
    this.elements.submitPoint.textContent = "Save point";
    this.elements.clearForm.textContent = "Clear";
  }

  renderPoints(points, editingPointId = null) {
    this.elements.pointsCount.textContent = String(points.length);
    this.elements.clearAllPoints.disabled = !this.appReady || points.length === 0;

    if (points.length === 0) {
      this.elements.pointsList.innerHTML =
        '<li class="empty-state">No saved points yet. Add one from the form or Shift-click on the globe.</li>';
      return;
    }

    this.elements.pointsList.innerHTML = "";

    points.forEach((point) => {
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
      this.elements.pointsList.append(item);
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
      this.elements.clearForm
    ].forEach((control) => {
      control.disabled = !ready;
    });
    this.elements.clearAllPoints.disabled = !ready || Number(this.elements.pointsCount.textContent) === 0;
  }

  setFormBusy(busy) {
    this.elements.form.setAttribute("aria-busy", String(busy));
    Array.from(this.elements.form.elements).forEach((control) => {
      control.disabled = busy;
    });
    this.elements.submitPoint.textContent = busy
      ? "Saving…"
      : this.elements.editorMode.dataset.mode === "editing"
        ? "Update point"
        : "Save point";
  }

  setCurrentLocationButtonState({ disabled = false, busy = false, available = false, message = "" } = {}) {
    this.elements.centerCurrentLocation.disabled = disabled || busy;
    this.elements.centerCurrentLocation.textContent = busy
      ? "Locating…"
      : available
        ? "Center on my location"
        : disabled
          ? "Location unavailable"
          : "Find my location";
    this.elements.centerCurrentLocation.title = message;
  }

  #syncColorValue() {
    this.elements.colorValue.value = this.elements.color.value.toUpperCase();
  }
}
