export function emptyFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: []
  };
}

export function pointsToFeatureCollection(points) {
  return {
    type: "FeatureCollection",
    features: points.map((point) => ({
      type: "Feature",
      id: point.id,
      geometry: {
        type: "Point",
        coordinates: [point.longitude, point.latitude]
      },
      properties: {
        id: point.id,
        label: point.label,
        color: point.color,
        created_at: point.created_at
      }
    }))
  };
}

export function currentLocationToFeatureCollection(location) {
  if (!location) {
    return emptyFeatureCollection();
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "current-location",
        geometry: {
          type: "Point",
          coordinates: [location.longitude, location.latitude]
        },
        properties: {
          label: "Current location"
        }
      }
    ]
  };
}

export function trackedDevicesToFeatureCollection(devices) {
  return {
    type: "FeatureCollection",
    features: devices
      .filter((device) => device.latest_location)
      .map((device) => ({
        type: "Feature",
        id: device.id,
        geometry: {
          type: "Point",
          coordinates: [device.latest_location.longitude, device.latest_location.latitude]
        },
        properties: {
          id: device.id,
          label: device.name,
          accuracy: device.latest_location.accuracy,
          captured_at: device.latest_location.captured_at
        }
      }))
  };
}
