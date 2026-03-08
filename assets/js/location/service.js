function buildLocationError(error) {
  switch (error?.code) {
    case 1:
      return new Error("Location permission was denied by the browser.");
    case 2:
      return new Error("The browser could not determine the current location.");
    case 3:
      return new Error("The location request timed out.");
    default:
      return new Error(error?.message || "Current location is unavailable.");
  }
}

export class LocationService extends EventTarget {
  constructor() {
    super();
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
      this.watchId = globalThis.navigator.geolocation.watchPosition(
        (position) => this.#handleSuccess(position),
        (error) => this.#handleError(error),
        {
          enableHighAccuracy: true,
          maximumAge: 30_000,
          timeout: 15_000,
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
