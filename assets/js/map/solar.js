const MILLISECONDS_PER_DAY = 86_400_000;
const JULIAN_UNIX_EPOCH = 2_440_587.5;
const JULIAN_J2000 = 2_451_545;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function normalizeLongitude(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

export function smoothStep(minimum, maximum, value) {
  const position = Math.min(1, Math.max(0, (value - minimum) / (maximum - minimum)));
  return position * position * (3 - 2 * position);
}

function julianDay(date) {
  return date.getTime() / MILLISECONDS_PER_DAY + JULIAN_UNIX_EPOCH;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("A valid date is required for solar calculations.");
  }
  return date;
}

export function getSolarPosition(value = new Date()) {
  const date = validDate(value);
  const julianCentury = (julianDay(date) - JULIAN_J2000) / 36_525;

  const geometricMeanLongitude = normalizeDegrees(
    280.46646 + julianCentury * (36_000.76983 + julianCentury * 0.0003032)
  );
  const geometricMeanAnomaly = normalizeDegrees(
    357.52911 + julianCentury * (35_999.05029 - 0.0001537 * julianCentury)
  );
  const orbitEccentricity =
    0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);
  const anomalyRadians = toRadians(geometricMeanAnomaly);
  const equationOfCenter =
    Math.sin(anomalyRadians) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
    Math.sin(2 * anomalyRadians) * (0.019993 - 0.000101 * julianCentury) +
    Math.sin(3 * anomalyRadians) * 0.000289;
  const trueLongitude = geometricMeanLongitude + equationOfCenter;
  const ascendingNodeLongitude = 125.04 - 1934.136 * julianCentury;
  const apparentLongitude =
    trueLongitude - 0.00569 - 0.00478 * Math.sin(toRadians(ascendingNodeLongitude));

  const obliquitySeconds =
    21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813));
  const meanObliquity = 23 + (26 + obliquitySeconds / 60) / 60;
  const correctedObliquity =
    meanObliquity + 0.00256 * Math.cos(toRadians(ascendingNodeLongitude));
  const obliquityRadians = toRadians(correctedObliquity);
  const apparentLongitudeRadians = toRadians(apparentLongitude);
  const declination = toDegrees(
    Math.asin(Math.sin(obliquityRadians) * Math.sin(apparentLongitudeRadians))
  );

  const longitudeRadians = toRadians(geometricMeanLongitude);
  const obliquityFactor = Math.tan(obliquityRadians / 2) ** 2;
  const equationOfTime =
    4 *
    toDegrees(
      obliquityFactor * Math.sin(2 * longitudeRadians) -
        2 * orbitEccentricity * Math.sin(anomalyRadians) +
        4 * orbitEccentricity * obliquityFactor * Math.sin(anomalyRadians) * Math.cos(2 * longitudeRadians) -
        0.5 * obliquityFactor ** 2 * Math.sin(4 * longitudeRadians) -
        1.25 * orbitEccentricity ** 2 * Math.sin(2 * anomalyRadians)
    );
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000;
  const subsolarLongitude = normalizeLongitude((720 - utcMinutes - equationOfTime) / 4);

  return {
    date,
    latitude: declination,
    longitude: subsolarLongitude,
    equationOfTimeMinutes: equationOfTime
  };
}

export function getSolarElevation(solarPosition, latitude, longitude) {
  const latitudeRadians = toRadians(latitude);
  const declinationRadians = toRadians(solarPosition.latitude);
  const hourAngleRadians = toRadians(normalizeLongitude(longitude - solarPosition.longitude));
  const altitudeSine =
    Math.sin(latitudeRadians) * Math.sin(declinationRadians) +
    Math.cos(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourAngleRadians);

  return toDegrees(Math.asin(Math.min(1, Math.max(-1, altitudeSine))));
}

/**
 * Unit vector from the Earth's centre towards a geographic coordinate, in the globe's
 * Earth-fixed frame: +y is north, +z crosses the prime meridian and +x points to 90°E.
 */
export function getSurfaceVector(latitude, longitude) {
  const latitudeRadians = toRadians(latitude);
  const longitudeRadians = toRadians(longitude);
  const cosLatitude = Math.cos(latitudeRadians);
  return [
    Math.sin(longitudeRadians) * cosLatitude,
    Math.sin(latitudeRadians),
    Math.cos(longitudeRadians) * cosLatitude
  ];
}

export function getSunDirection(solarPosition) {
  return getSurfaceVector(solarPosition.latitude, solarPosition.longitude);
}

/** Greenwich mean sidereal time in radians, used to keep the starfield fixed to the sky. */
export function getSiderealAngle(value = new Date()) {
  const daysSinceJ2000 = julianDay(validDate(value)) - JULIAN_J2000;
  return toRadians(normalizeDegrees(280.46061837 + 360.98564736629 * daysSinceJ2000));
}
