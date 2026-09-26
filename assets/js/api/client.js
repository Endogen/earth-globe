import { formatApiErrorDetail } from "../utils/formatters.js?v=0.5.0";

const JSON_HEADERS = {
  Accept: "application/json"
};

export class ApiClient extends EventTarget {
  constructor(baseUrl = "/api") {
    super();
    this.baseUrl = baseUrl;
    this.pendingRequests = new Set();
  }

  cancelPending() {
    for (const controller of this.pendingRequests) controller.abort();
    this.pendingRequests.clear();
  }

  async unlock(controlKey) {
    return this.#request("/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ control_key: controlKey })
    });
  }

  async getSession() {
    return this.#request("/auth/session");
  }

  async lock() {
    return this.#request("/auth/session", { method: "DELETE" });
  }

  async getConfig() {
    return this.#request("/config");
  }

  async listPoints() {
    return this.#request("/points");
  }

  async createPoint(payload) {
    return this.#request("/points", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  }

  async updatePoint(pointId, payload) {
    return this.#request(`/points/${encodeURIComponent(pointId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  }

  async deletePoint(pointId) {
    return this.#request(`/points/${encodeURIComponent(pointId)}`, {
      method: "DELETE"
    });
  }

  async deleteAllPoints() {
    return this.#request("/points", {
      method: "DELETE"
    });
  }

  async getTrackingStatus() {
    return this.#request("/tracking/status");
  }

  async listDevices() {
    return this.#trackingRequest("/devices");
  }

  async createPairingCode(deviceName) {
    return this.#trackingRequest("/devices/pairing-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: deviceName })
    });
  }

  async requestDeviceLocation(deviceId) {
    return this.#trackingRequest(`/devices/${encodeURIComponent(deviceId)}/location-requests`, {
      method: "POST"
    });
  }

  async deleteDevice(deviceId) {
    return this.#trackingRequest(`/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE"
    });
  }

  async #trackingRequest(path, options = {}) {
    return this.#request(path, options);
  }

  async #request(path, options = {}) {
    const controller = new AbortController();
    this.pendingRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("The server took too long. Please try again.")), 15_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        credentials: "same-origin",
        headers: { ...JSON_HEADERS, ...(options.headers ?? {}) }
      });
      const contentType = response.headers.get("content-type") ?? "";
      const payload = response.status === 204 ? null : contentType.includes("application/json")
        ? await response.json() : await response.text();
      if (!response.ok) {
        const detail = typeof payload === "object" ? payload?.detail : payload;
        const error = new Error(formatApiErrorDetail(detail) || `Request failed with status ${response.status}`);
        error.status = response.status;
        if (response.status === 401 && path !== "/auth/session") this.dispatchEvent(new Event("unauthorized"));
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      this.pendingRequests.delete(controller);
    }
  }
}
