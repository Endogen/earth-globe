export class PointsStore extends EventTarget {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.points = [];
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
    return [...this.points];
  }

  async load() {
    const generation = this.generation;
    const sequence = ++this.loadSequence;
    const data = await this.apiClient.listPoints();
    if (generation === this.generation && sequence === this.loadSequence) {
      this.points = data;
      this.#emit();
    }
    return this.snapshot();
  }

  async add(payload) {
    return this.#enqueueMutation(async (generation) => {
      const point = await this.apiClient.createPoint(payload);
      if (generation !== this.generation) return;
      this.loadSequence += 1;
      this.points = [...this.points, point];
      this.#emit();
      return point;
    });
  }

  async update(pointId, payload) {
    return this.#enqueueMutation(async (generation) => {
      const updatedPoint = await this.apiClient.updatePoint(pointId, payload);
      if (generation !== this.generation) return;
      this.loadSequence += 1;
      this.points = this.points.map((point) => (point.id === pointId ? updatedPoint : point));
      this.#emit();
      return updatedPoint;
    });
  }

  async remove(pointId) {
    return this.#enqueueMutation(async (generation) => {
      const removedPoint = await this.apiClient.deletePoint(pointId);
      if (generation !== this.generation) return;
      this.loadSequence += 1;
      this.points = this.points.filter((point) => point.id !== pointId);
      this.#emit();
      return removedPoint;
    });
  }

  async clear() {
    return this.#enqueueMutation(async (generation) => {
      const result = await this.apiClient.deleteAllPoints();
      if (generation !== this.generation) return;
      this.loadSequence += 1;
      this.points = [];
      this.#emit();
      return result;
    });
  }

  reset() {
    this.generation += 1;
    this.points = [];
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
