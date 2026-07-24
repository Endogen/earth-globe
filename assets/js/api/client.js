import { formatApiErrorDetail } from "../utils/formatters.js";

const JSON_HEADERS = {
  Accept: "application/json"
};

export class ApiClient {
  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl;
    this.trackingToken = "";
  }

  setTrackingToken(token) {
    this.trackingToken = token.trim();
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
    if (!this.trackingToken) {
      throw new Error("Enter the device-tracking control key first.");
    }
    return this.#request(path, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        Authorization: `Bearer ${this.trackingToken}`
      }
    });
  }

  async #request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...JSON_HEADERS,
        ...(options.headers ?? {})
      }
    });

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok) {
      const detail = typeof payload === "object" ? payload?.detail : payload;
      throw new Error(formatApiErrorDetail(detail) || `Request failed with status ${response.status}`);
    }

    return payload;
  }
}
