const JSON_HEADERS = {
  Accept: "application/json"
};

export class ApiClient {
  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl;
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
      throw new Error(detail || `Request failed with status ${response.status}`);
    }

    return payload;
  }
}
