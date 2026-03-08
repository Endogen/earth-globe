export function formatCoordinate(value) {
  return Number(value).toFixed(4);
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

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
