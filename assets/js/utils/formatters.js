export function formatCoordinate(value) {
  return Number(value).toFixed(4);
}

export function normalizeLongitude(value) {
  const longitude = Number(value);
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function normalizeCoordinates({ latitude, longitude }) {
  return {
    latitude: Math.min(90, Math.max(-90, Number(latitude))),
    longitude: normalizeLongitude(longitude)
  };
}

export function formatCoordinates(latitude, longitude) {
  return `${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
}

export function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatApiErrorDetail(detail) {
  if (typeof detail === "string") {
    return detail;
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((issue) => {
        if (!issue || typeof issue !== "object") {
          return null;
        }

        const field = Array.isArray(issue.loc) ? issue.loc.at(-1) : null;
        const message = typeof issue.msg === "string" ? issue.msg : null;
        if (!message) {
          return null;
        }

        return field ? `${String(field).replaceAll("_", " ")}: ${message}` : message;
      })
      .filter(Boolean);

    if (messages.length > 0) {
      return messages.join(" · ");
    }
  }

  return null;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
