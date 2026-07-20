export class PointsStore extends EventTarget {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.points = [];
    this.mutationQueue = Promise.resolve();
  }

  subscribe(listener) {
    const handler = (event) => listener(event.detail);
    this.addEventListener("change", handler);
    listener(this.snapshot());
    return () => this.removeEventListener("change", handler);
  }

  snapshot() {
    return [...this.points];
  }

  async load() {
    this.points = await this.apiClient.listPoints();
    this.#emit();
    return this.snapshot();
  }

  async add(payload) {
    return this.#enqueueMutation(async () => {
      const point = await this.apiClient.createPoint(payload);
      this.points = [...this.points, point];
      this.#emit();
      return point;
    });
  }

  async update(pointId, payload) {
    return this.#enqueueMutation(async () => {
      const updatedPoint = await this.apiClient.updatePoint(pointId, payload);
      this.points = this.points.map((point) => (point.id === pointId ? updatedPoint : point));
      this.#emit();
      return updatedPoint;
    });
  }

  async remove(pointId) {
    return this.#enqueueMutation(async () => {
      const removedPoint = await this.apiClient.deletePoint(pointId);
      this.points = this.points.filter((point) => point.id !== pointId);
      this.#emit();
      return removedPoint;
    });
  }

  async clear() {
    return this.#enqueueMutation(async () => {
      const result = await this.apiClient.deleteAllPoints();
      this.points = [];
      this.#emit();
      return result;
    });
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
