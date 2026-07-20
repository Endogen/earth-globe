const MILLISECONDS_PER_DAY = 86_400_000;
const JULIAN_UNIX_EPOCH = 2_440_587.5;
const JULIAN_J2000 = 2_451_545;

export const SOLAR_TEXTURE_WIDTH = 720;
export const SOLAR_TEXTURE_HEIGHT = 360;

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

function smoothStep(minimum, maximum, value) {
  const position = Math.min(1, Math.max(0, (value - minimum) / (maximum - minimum)));
  return position * position * (3 - 2 * position);
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
  const julianDay = date.getTime() / MILLISECONDS_PER_DAY + JULIAN_UNIX_EPOCH;
  const julianCentury = (julianDay - JULIAN_J2000) / 36_525;

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

export function getNightOpacity(solarElevation) {
  if (solarElevation >= 0) {
    return 0;
  }

  const darknessDepth = Math.min(90, -solarElevation);
  if (darknessDepth <= 18) {
    return 0.58 * smoothStep(0, 18, darknessDepth);
  }

  return 0.58 + 0.2 * smoothStep(18, 60, darknessDepth);
}

function getNightColor(solarElevation) {
  const nightProgress = smoothStep(0, 24, Math.max(0, -solarElevation));
  return [
    Math.round(15 + (1 - 15) * nightProgress),
    Math.round(33 + (5 - 33) * nightProgress),
    Math.round(56 + (14 - 56) * nightProgress)
  ];
}

export function createSolarTextureData(
  solarPosition,
  width = SOLAR_TEXTURE_WIDTH,
  height = SOLAR_TEXTURE_HEIGHT
) {
  const textureWidth = Math.max(2, Math.floor(Number(width)) || SOLAR_TEXTURE_WIDTH);
  const textureHeight = Math.max(2, Math.floor(Number(height)) || SOLAR_TEXTURE_HEIGHT);
  const pixels = new Uint8ClampedArray(textureWidth * textureHeight * 4);
  const declinationRadians = toRadians(solarPosition.latitude);
  const sinDeclination = Math.sin(declinationRadians);
  const cosDeclination = Math.cos(declinationRadians);
  const longitudeCosines = new Float64Array(textureWidth);

  for (let x = 0; x < textureWidth; x += 1) {
    const longitude = -180 + ((x + 0.5) / textureWidth) * 360;
    longitudeCosines[x] = Math.cos(toRadians(normalizeLongitude(longitude - solarPosition.longitude)));
  }

  for (let y = 0; y < textureHeight; y += 1) {
    const mercatorY = (y + 0.5) / textureHeight;
    const latitudeRadians = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY)));
    const sinLatitude = Math.sin(latitudeRadians);
    const cosLatitude = Math.cos(latitudeRadians);

    for (let x = 0; x < textureWidth; x += 1) {
      const altitudeSine =
        sinLatitude * sinDeclination + cosLatitude * cosDeclination * longitudeCosines[x];
      const solarElevation = toDegrees(Math.asin(Math.min(1, Math.max(-1, altitudeSine))));
      const opacity = getNightOpacity(solarElevation);
      const [red, green, blue] = getNightColor(solarElevation);
      const offset = (y * textureWidth + x) * 4;

      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = Math.round(opacity * 255);
    }
  }

  return { width: textureWidth, height: textureHeight, pixels };
}

export function drawSolarTexture(canvas, solarPosition) {
  const texture = createSolarTextureData(solarPosition, canvas.width, canvas.height);
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new Error("The browser could not create the solar texture.");
  }

  const imageData = context.createImageData(texture.width, texture.height);
  imageData.data.set(texture.pixels);
  context.putImageData(imageData, 0, 0);
}
