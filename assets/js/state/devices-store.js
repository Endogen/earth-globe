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
    this.generation = 0;
    this.loadSequence = 0;
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
    const generation = this.generation;
    const sequence = ++this.loadSequence;
    const data = await this.apiClient.listDevices();
    if (generation === this.generation && sequence === this.loadSequence) {
      this.devices = data;
      this.#emit();
    }
    return this.snapshot();
  }

  async requestLocation(deviceId) {
    return this.#enqueueMutation(async (generation) => {
      const request = await this.apiClient.requestDeviceLocation(deviceId);
      if (generation !== this.generation) return;
      this.loadSequence += 1;
      await this.load();
      return request;
    });
  }

  async remove(deviceId) {
    return this.#enqueueMutation(async (generation) => {
      const removed = await this.apiClient.deleteDevice(deviceId);
      if (generation !== this.generation) return;
      this.loadSequence += 1;
      this.devices = this.devices.filter((device) => device.id !== deviceId);
      this.#emit();
      return removed;
    });
  }

  clear() {
    this.generation += 1;
    this.devices = [];
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.snapshot() }));
  }

  #enqueueMutation(operation) {
    const generation = this.generation;
    const run = () => generation === this.generation ? operation(generation) : undefined;
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }
}
