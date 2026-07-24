export function getDeviceRefreshDelay({ hidden = false, hasActiveRequest = false, retrying = false } = {}) {
  if (retrying) {
    return hidden ? 30_000 : 8_000;
  }
  if (hidden) {
    return hasActiveRequest ? 5_000 : 20_000;
  }
  return hasActiveRequest ? 750 : 4_000;
}

export function getDeviceRefreshStatus({
  hadActiveRequest = false,
  hasActiveRequest = false,
  previousDeviceCount = 0,
  deviceCount = 0
} = {}) {
  if (hasActiveRequest) {
    return "Waiting for the requested location…";
  }
  if (hadActiveRequest || previousDeviceCount !== deviceCount) {
    return "Device status is live. Location timestamps and accuracy are shown below.";
  }
  return null;
}

export class DevicesStore extends EventTarget {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.devices = [];
    this.mutationQueue = Promise.resolve();
  }

  subscribe(listener) {
    const handler = (event) => listener(event.detail);
    this.addEventListener("change", handler);
    listener(this.snapshot());
    return () => this.removeEventListener("change", handler);
  }

  snapshot() {
    return this.devices.map((device) => ({ ...device }));
  }

  async load() {
    this.devices = await this.apiClient.listDevices();
    this.#emit();
    return this.snapshot();
  }

  async requestLocation(deviceId) {
    return this.#enqueueMutation(async () => {
      const request = await this.apiClient.requestDeviceLocation(deviceId);
      await this.load();
      return request;
    });
  }

  async remove(deviceId) {
    return this.#enqueueMutation(async () => {
      const removed = await this.apiClient.deleteDevice(deviceId);
      this.devices = this.devices.filter((device) => device.id !== deviceId);
      this.#emit();
      return removed;
    });
  }

  clear() {
    this.devices = [];
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.snapshot() }));
  }

  #enqueueMutation(operation) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }
}
