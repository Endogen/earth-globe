export function buildLocationError(error) {
  switch (error?.code) {
    case 1:
      return new Error("Location access is blocked. Allow it for this site and browser, then try again.");
    case 2:
      return new Error(
        "Your device could not provide a location. Check system Location Services and Wi-Fi, then try again."
      );
    case 3:
      return new Error("The location request timed out. Check Location Services or try again.");
    default:
      return new Error(error?.message || "Current location is unavailable.");
  }
}

export class LocationService extends EventTarget {
  constructor() {
    super();
    this.generation = 0;
    this.watchId = null;
    this.currentLocation = null;
    this.pendingFirstFix = null;
    this.resolveFirstFix = null;
    this.rejectFirstFix = null;
  }

  isSupported() {
    return Boolean(globalThis.navigator?.geolocation);
  }

  isSecureContext() {
    return Boolean(globalThis.isSecureContext);
  }

  getCurrentLocation() {
    return this.currentLocation ? { ...this.currentLocation } : null;
  }

  stopTracking() {
    this.generation += 1;
    this.currentLocation = null;
    this.rejectFirstFix?.(new Error("Location request stopped."));
    if (this.watchId !== null && this.isSupported()) {
      globalThis.navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
    this.#clearPendingFirstFix();
  }

  async ensureTracking(options = {}) {
    const availabilityError = this.#getAvailabilityError();
    if (availabilityError) {
      throw availabilityError;
    }

    if (this.currentLocation) {
      return this.getCurrentLocation();
    }

    if (this.pendingFirstFix) {
      return this.pendingFirstFix;
    }

    this.pendingFirstFix = new Promise((resolve, reject) => {
      this.resolveFirstFix = resolve;
      this.rejectFirstFix = reject;
    });

    if (this.watchId === null) {
      const generation = this.generation;
      this.watchId = globalThis.navigator.geolocation.watchPosition(
        (position) => { if (generation === this.generation) this.#handleSuccess(position); },
        (error) => { if (generation === this.generation) this.#handleError(error); },
        {
          enableHighAccuracy: false,
          maximumAge: 300_000,
          timeout: 20_000,
          ...options
        }
      );
    }

    return this.pendingFirstFix;
  }

  #getAvailabilityError() {
    if (!this.isSupported()) {
      return new Error("This browser does not expose geolocation.");
    }

    if (!this.isSecureContext()) {
      return new Error("Current location requires HTTPS or localhost in the browser.");
    }

    return null;
  }

  #handleSuccess(position) {
    this.currentLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: new Date(position.timestamp).toISOString()
    };

    if (this.resolveFirstFix) {
      this.resolveFirstFix(this.getCurrentLocation());
      this.#clearPendingFirstFix();
    }

    this.dispatchEvent(new CustomEvent("locationchange", { detail: this.getCurrentLocation() }));
  }

  #handleError(error) {
    const wrappedError = buildLocationError(error);

    if (this.rejectFirstFix) {
      this.rejectFirstFix(wrappedError);
      this.#clearPendingFirstFix();
    }

    if (!this.currentLocation && this.watchId !== null) {
      globalThis.navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }

    this.dispatchEvent(new CustomEvent("locationerror", { detail: wrappedError }));
  }

  #clearPendingFirstFix() {
    this.pendingFirstFix = null;
    this.resolveFirstFix = null;
    this.rejectFirstFix = null;
  }
}
