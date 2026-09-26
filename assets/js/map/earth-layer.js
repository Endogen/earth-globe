import { getSiderealAngle, getSolarPosition, getSunDirection, smoothStep } from "./solar.js?v=0.5.0";

export const EARTH_LAYER_ID = "earth-lighting";
const MESH_STEP_DEGREES = 2.5;
const MERCATOR_MAX_LATITUDE_RADIANS = 1.4844222297453324;
const LIVE_SUN_REFRESH_MS = 1_000;
const MAX_ANISOTROPY = 8;
// Sources are listed largest first; the largest one the GPU can hold is used.
const TEXTURES = {
  day: { unit: 0, format: "RGB", sources: [{ url: "/assets/textures/earth-day.jpg", width: 4096 }] },
  night: {
    unit: 1,
    format: "LUMINANCE",
    sources: [
      { url: "/assets/textures/earth-night-8k.jpg", width: 8192 },
      { url: "/assets/textures/earth-night.jpg", width: 4096 }
    ]
  },
  water: { unit: 2, format: "LUMINANCE", sources: [{ url: "/assets/textures/earth-water.png", width: 2048 }] }
};

const SURFACE_VERTEX_SHADER = `
attribute vec2 a_lnglat;
varying vec3 v_position;
varying vec2 v_uv;

void main() {
  float longitude = radians(a_lnglat.x);
  float latitude = radians(a_lnglat.y);
  vec3 spherePosition = vec3(sin(longitude) * cos(latitude), sin(latitude), cos(longitude) * cos(latitude));
  v_position = spherePosition;
  v_uv = vec2((a_lnglat.x + 180.0) / 360.0, (90.0 - a_lnglat.y) / 180.0);

  float mercatorLatitude = clamp(latitude, -${MERCATOR_MAX_LATITUDE_RADIANS}, ${MERCATOR_MAX_LATITUDE_RADIANS});
  vec2 mercator = vec2(v_uv.x, 0.5 - log(tan(PI * 0.25 + mercatorLatitude * 0.5)) / (2.0 * PI));
#ifdef GLOBE
  gl_Position = interpolateProjection(mercator, spherePosition, 0.0);
#else
  gl_Position = projectTile(mercator);
#endif
}`;

// Lighting shared by the sphere mesh (globe rendering) and the ground pass (flat rendering at high zoom).
const SURFACE_SHADING = `
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_water;
uniform vec3 u_sun;
uniform vec3 u_eye;
uniform float u_imagery;
uniform float u_lights;
uniform vec2 u_night_size;
uniform float u_pixel_ratio;
uniform float u_glint;
uniform float u_max_darkness;

// Cubic B-spline weights. Four bilinear taps at shifted positions reproduce the 16-tap bicubic filter.
vec4 bSplineWeights(float t) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - t;
  vec4 cubes = n * n * n;
  float x = cubes.x;
  float y = cubes.y - 4.0 * cubes.x;
  float z = cubes.z - 4.0 * cubes.y + 6.0 * cubes.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}

// Smooth magnification without bilinear's visible texel grid. The true uv derivatives are passed on,
// because the shifted tap coordinates jump between texels and would otherwise corrupt mip selection.
float sampleBicubic(sampler2D map, vec2 uv, vec2 size, vec2 uvDx, vec2 uvDy) {
  vec2 coord = uv * size - 0.5;
  vec2 fraction = fract(coord);
  coord -= fraction;
  vec4 wx = bSplineWeights(fraction.x);
  vec4 wy = bSplineWeights(fraction.y);
  vec4 sums = vec4(wx.xz + wx.yw, wy.xz + wy.yw);
  vec4 taps = (coord.xxyy + vec2(-0.5, 1.5).xyxy + vec4(wx.yw, wy.yw) / sums) / size.xxyy;
  float mixX = sums.x / (sums.x + sums.y);
  float mixY = sums.z / (sums.z + sums.w);
  return mix(
    mix(textureGrad(map, taps.yw, uvDx, uvDy).r, textureGrad(map, taps.xw, uvDx, uvDy).r, mixX),
    mix(textureGrad(map, taps.yz, uvDx, uvDy).r, textureGrad(map, taps.xz, uvDx, uvDy).r, mixX),
    mixY
  );
}

vec4 shadeSurface(vec3 normal, vec2 uv) {
  float elevation = degrees(asin(clamp(dot(normal, u_sun), -1.0, 1.0)));
  vec2 uvDx = dFdx(uv);
  vec2 uvDy = dFdy(uv);

  // Daylight falls steeply through civil twilight and fades out by the end of astronomical twilight.
  float daylight = 0.85 * smoothstep(-8.0, 3.0, elevation) + 0.15 * smoothstep(-18.0, -8.0, elevation);
  float lowSun = mix(0.74, 1.0, smoothstep(0.0, 40.0, elevation));
  float darkness = u_max_darkness * (1.0 - daylight * lowSun);

  float dusk = exp(-pow((elevation - 0.5) / 4.5, 2.0));
  vec3 shadowColor = mix(vec3(0.010, 0.018, 0.045), vec3(0.42, 0.17, 0.08), dusk * 0.45);

  vec3 day = textureGrad(u_day, uv, uvDx, uvDy).rgb;
  day = mix(vec3(dot(day, vec3(0.2126, 0.7152, 0.0722))), day, 1.12);

  // CSS pixels covered by one texel of the night-lights data at this fragment. Derivatives are in
  // device pixels; dividing by the pixel ratio makes the fade track perceived blur on any display.
  float texelsPerPixel = max(length(uvDx * u_night_size), length(uvDy * u_night_size));
  float pixelsPerTexel = 1.0 / max(texelsPerPixel * u_pixel_ratio, 1e-4);
  float lightLevel = mix(
    textureGrad(u_night, uv, uvDx, uvDy).r,
    sampleBicubic(u_night, uv, u_night_size, uvDx, uvDy),
    smoothstep(0.75, 1.5, pixelsPerTexel)
  );
  // The satellite data is kilometres per texel and cannot resolve streets. It is fully gone before a
  // texel spans 3 CSS pixels: against the dark night map even a faint remainder reads as a smear.
  float resolvable = 1.0 - smoothstep(1.8, 3.0, pixelsPerTexel);
  float lightsOn = 1.0 - smoothstep(-6.0, 1.0, elevation);
  vec3 cityLights = vec3(1.0, 0.74, 0.42) * pow(lightLevel, 1.35) * 1.25 * lightsOn * resolvable * u_lights;

  vec3 viewDirection = normalize(u_eye - normal);
  float highlight = max(dot(normal, normalize(u_sun + viewDirection)), 0.0);
  float glint = (0.85 * pow(highlight, 900.0) + 0.14 * pow(highlight, 55.0))
    * textureGrad(u_water, uv, uvDx, uvDy).r * smoothstep(-1.0, 6.0, elevation) * u_glint;
  vec3 glintColor = mix(vec3(1.0, 0.56, 0.3), vec3(1.0, 0.97, 0.9), smoothstep(2.0, 20.0, elevation));

  // Premultiplied alpha: imagery over the base map, the shadow over both, then additive light.
  vec3 color = day * u_imagery * (1.0 - darkness) + shadowColor * darkness + cityLights + glintColor * glint;
  float alpha = 1.0 - (1.0 - u_imagery) * (1.0 - darkness);
  return vec4(color, alpha);
}`;

const MESH_FRAGMENT_SHADER = `${SURFACE_SHADING}
varying vec3 v_position;
varying vec2 v_uv;

void main() {
  gl_FragColor = shadeSurface(normalize(v_position), v_uv);
}`;

// Flat rendering reaches street level, where a world-spanning mesh cannot be projected precisely in
// float32: its far edge would be clipped short of the base map's. Instead every pixel casts its own
// ray onto the ground plane, using a matrix made relative to the view centre in float64 on the CPU.
const GROUND_FRAGMENT_SHADER = `${SURFACE_SHADING}
uniform mat4 u_inverse_local;
uniform vec2 u_origin;
varying vec2 v_ndc;

const float PI = 3.141592653589793;

void main() {
  vec4 nearPoint = u_inverse_local * vec4(v_ndc, -1.0, 1.0);
  vec4 farPoint = u_inverse_local * vec4(v_ndc, 1.0, 1.0);
  vec3 rayStart = nearPoint.xyz / nearPoint.w;
  vec3 rayEnd = farPoint.xyz / farPoint.w;
  float distanceToGround = rayStart.z / (rayStart.z - rayEnd.z);
  // Rays that never reach the ground (sky above a pitched horizon) are left untouched.
  if (!(distanceToGround > 0.0)) discard;

  vec2 mercator = u_origin + mix(rayStart.xy, rayEnd.xy, distanceToGround);
  float latitude = 2.0 * atan(exp(PI * (1.0 - 2.0 * mercator.y))) - PI * 0.5;
  float longitude = mercator.x * 2.0 * PI - PI;
  vec3 normal = vec3(sin(longitude) * cos(latitude), sin(latitude), cos(longitude) * cos(latitude));
  // mercator.x keeps counting across world copies, so the texture repeats without a seam.
  gl_FragColor = shadeSurface(normal, vec2(mercator.x, 0.5 - latitude / PI));
}`;

const SCREEN_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_ndc;

void main() {
  v_ndc = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const ATMOSPHERE_FRAGMENT_SHADER = `
uniform vec4 u_row_x;
uniform vec4 u_row_y;
uniform vec4 u_row_w;
uniform vec3 u_eye;
uniform vec3 u_sun;
uniform float u_strength;
uniform float u_pixel_angle;
uniform float u_sidereal;
varying vec2 v_ndc;

const int STEPS = 10;
const float ATMOSPHERE_RADIUS = 1.03;
const float SCALE_HEIGHT = 0.0075;
const vec3 RAYLEIGH = vec3(0.26, 0.52, 1.0);
const vec3 SPACE = vec3(0.004, 0.008, 0.018);
// Faint upper-atmosphere airglow keeps the night-side limb visible against space.
const vec3 AIRGLOW = vec3(0.05, 0.11, 0.2);

vec2 sphereHits(vec3 origin, vec3 direction, float radius) {
  float b = dot(origin, direction);
  float h = b * b - dot(origin, origin) + radius * radius;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 starLayer(vec3 direction, float scale, float probability, float brightness) {
  vec3 cell = floor(direction * scale);
  float seed = hash13(cell);
  if (seed > probability) return vec3(0.0);
  vec3 center = normalize(cell + 0.25 + 0.5 * hash33(cell));
  float pixels = length(cross(direction, center)) / u_pixel_angle;
  float magnitude = pow(seed / probability, 3.0) * brightness;
  vec3 tint = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.84, 0.66), hash13(cell + 17.0));
  return tint * magnitude * exp(-pixels * pixels * 1.6);
}

void main() {
  vec3 edgeX = u_row_x.xyz - v_ndc.x * u_row_w.xyz;
  vec3 edgeY = u_row_y.xyz - v_ndc.y * u_row_w.xyz;
  vec3 direction = normalize(cross(edgeX, edgeY));
  if (dot(direction, u_row_w.xyz) < 0.0) direction = -direction;

  vec2 planet = sphereHits(u_eye, direction, 1.0);
  bool hitsPlanet = planet.x > 0.0;
  vec2 shell = sphereHits(u_eye, direction, ATMOSPHERE_RADIUS);

  vec3 scattered = vec3(0.0);
  float opticalDepth = 0.0;
  if (shell.y > 0.0) {
    float start = max(shell.x, 0.0);
    float stepLength = ((hitsPlanet ? planet.x : shell.y) - start) / float(STEPS);
    float cosView = dot(direction, u_sun);
    float rayleighPhase = 0.75 * (1.0 + cosView * cosView);
    float miePhase = 0.07 * 0.4224 / pow(1.5776 - 1.52 * cosView, 1.5);
    for (int i = 0; i < STEPS; i++) {
      vec3 samplePoint = u_eye + direction * (start + (float(i) + 0.5) * stepLength);
      float radius = length(samplePoint);
      float density = exp(-(radius - 1.0) / SCALE_HEIGHT);
      float sunHeight = dot(samplePoint / radius, u_sun);
      float sunlit = smoothstep(-0.16, 0.06, sunHeight);
      vec3 sunColor = mix(vec3(1.0, 0.36, 0.12), vec3(1.0), smoothstep(-0.04, 0.35, sunHeight));
      scattered += density * (sunlit * sunColor * (RAYLEIGH * rayleighPhase + miePhase) + AIRGLOW);
      opticalDepth += density;
    }
    scattered *= stepLength;
    opticalDepth *= stepLength;
  }
  vec3 glow = (1.0 - exp(-scattered * 9.0)) * u_strength;

  if (hitsPlanet) {
    float haze = (1.0 - exp(-opticalDepth * 3.0)) * u_strength;
    gl_FragColor = vec4(glow, haze);
    return;
  }

  float s = sin(u_sidereal);
  float c = cos(u_sidereal);
  vec3 skyDirection = vec3(direction.x * c + direction.z * s, direction.y, direction.z * c - direction.x * s);
  vec3 stars = starLayer(skyDirection, 60.0, 0.3, 1.1) + starLayer(skyDirection, 170.0, 0.08, 0.5);
  float glowLevel = max(glow.r, max(glow.g, glow.b));
  vec3 color = SPACE + stars * (1.0 - glowLevel) + glow;
  gl_FragColor = vec4(color * u_strength, u_strength);
}`;

/** Latitude/longitude grid covering the whole sphere, poles included, split at the antimeridian. */
export function createSphereMesh(stepDegrees = MESH_STEP_DEGREES) {
  const columns = Math.round(360 / stepDegrees);
  const rows = Math.round(180 / stepDegrees);
  const vertices = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices = new Uint16Array(columns * rows * 6);
  if ((columns + 1) * (rows + 1) > 65_536) {
    throw new RangeError("The sphere mesh needs 32-bit indices at this resolution.");
  }

  let vertex = 0;
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      vertices[vertex++] = -180 + (column * 360) / columns;
      vertices[vertex++] = 90 - (row * 180) / rows;
    }
  }

  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * (columns + 1) + column;
      const bottomLeft = topLeft + columns + 1;
      indices.set([topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1], index);
      index += 6;
    }
  }
  return { vertices, indices };
}

function matrixRow(matrix, row) {
  return [matrix[row], matrix[4 + row], matrix[8 + row], matrix[12 + row]];
}

/**
 * Camera position in the matrix's object space: the point that projects to x = y = w = 0.
 * Works for any perspective matrix, so it does not depend on MapLibre's internal camera API.
 */
export function getCameraPosition(matrix) {
  const [a, b, c] = [matrixRow(matrix, 0), matrixRow(matrix, 1), matrixRow(matrix, 3)];
  const determinant =
    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(determinant) < 1e-12) return null;
  const [d0, d1, d2] = [-a[3], -b[3], -c[3]];
  return [
    (d0 * (b[1] * c[2] - b[2] * c[1]) - a[1] * (d1 * c[2] - b[2] * d2) + a[2] * (d1 * c[1] - b[1] * d2)) / determinant,
    (a[0] * (d1 * c[2] - b[2] * d2) - d0 * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * d2 - d1 * c[0])) / determinant,
    (a[0] * (b[1] * d2 - d1 * c[1]) - a[1] * (b[0] * d2 - d1 * c[0]) + d0 * (b[0] * c[1] - b[1] * c[0])) / determinant
  ];
}

/** Inverse of a column-major 4x4 matrix in full float64 precision, or null when it is singular. */
export function invertMatrix(m) {
  const b00 = m[0] * m[5] - m[1] * m[4];
  const b01 = m[0] * m[6] - m[2] * m[4];
  const b02 = m[0] * m[7] - m[3] * m[4];
  const b03 = m[1] * m[6] - m[2] * m[5];
  const b04 = m[1] * m[7] - m[3] * m[5];
  const b05 = m[2] * m[7] - m[3] * m[6];
  const b06 = m[8] * m[13] - m[9] * m[12];
  const b07 = m[8] * m[14] - m[10] * m[12];
  const b08 = m[8] * m[15] - m[11] * m[12];
  const b09 = m[9] * m[14] - m[10] * m[13];
  const b10 = m[9] * m[15] - m[11] * m[13];
  const b11 = m[10] * m[15] - m[11] * m[14];
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!determinant) return null;
  const inverse = 1 / determinant;
  return Float64Array.of(
    (m[5] * b11 - m[6] * b10 + m[7] * b09) * inverse,
    (m[2] * b10 - m[1] * b11 - m[3] * b09) * inverse,
    (m[13] * b05 - m[14] * b04 + m[15] * b03) * inverse,
    (m[10] * b04 - m[9] * b05 - m[11] * b03) * inverse,
    (m[6] * b08 - m[4] * b11 - m[7] * b07) * inverse,
    (m[0] * b11 - m[2] * b08 + m[3] * b07) * inverse,
    (m[14] * b02 - m[12] * b05 - m[15] * b01) * inverse,
    (m[8] * b05 - m[10] * b02 + m[11] * b01) * inverse,
    (m[4] * b10 - m[5] * b08 + m[7] * b06) * inverse,
    (m[1] * b08 - m[0] * b10 - m[3] * b06) * inverse,
    (m[12] * b04 - m[13] * b02 + m[15] * b00) * inverse,
    (m[9] * b02 - m[8] * b04 - m[11] * b00) * inverse,
    (m[5] * b07 - m[4] * b09 - m[6] * b06) * inverse,
    (m[0] * b09 - m[1] * b07 + m[2] * b06) * inverse,
    (m[13] * b01 - m[12] * b03 - m[14] * b00) * inverse,
    (m[8] * b03 - m[9] * b01 + m[10] * b00) * inverse
  );
}

function unprojectClipPoint(inverse, x, y, z) {
  const point = [0, 1, 2, 3].map((row) => inverse[row] * x + inverse[4 + row] * y + inverse[8 + row] * z + inverse[12 + row]);
  return point.slice(0, 3).map((value) => value / point[3]);
}

/**
 * For flat (mercator) rendering: the ground point under the screen centre, and the inverse of the
 * projection re-based onto it. Re-basing in float64 leaves the GPU only small, precise offsets.
 */
export function getLocalGroundProjection(matrix) {
  const inverse = invertMatrix(matrix);
  if (!inverse) return null;
  const near = unprojectClipPoint(inverse, 0, 0, -1);
  const far = unprojectClipPoint(inverse, 0, 0, 1);
  const distanceToGround = near[2] / (near[2] - far[2]);
  const origin = distanceToGround > 0
    ? [near[0] + (far[0] - near[0]) * distanceToGround, near[1] + (far[1] - near[1]) * distanceToGround]
    : [near[0], near[1]];

  const local = Float64Array.from(matrix);
  for (let row = 0; row < 4; row += 1) {
    local[12 + row] = matrix[row] * origin[0] + matrix[4 + row] * origin[1] + matrix[12 + row];
  }
  const inverseLocal = invertMatrix(local);
  return inverseLocal ? { origin, inverseLocal } : null;
}

/** Zoom-dependent blend levels: photographic from orbit, a readable map when zoomed in. */
export function getEarthLayerSettings(zoom, globeness = 1) {
  return {
    imagery: 1 - smoothStep(3.2, 5, zoom),
    glint: (1 - smoothStep(3.5, 5.5, zoom)) * globeness,
    maxDarkness: 0.93 - 0.21 * smoothStep(4, 11, zoom),
    atmosphere: (1 - smoothStep(5, 7, zoom)) * globeness
  };
}

/**
 * Decodes an image off the main thread, so large textures neither stall a frame on upload nor wait
 * for the tab to become visible (HTMLImageElement.decode only settles once the page renders).
 */
async function loadTextureImage(url) {
  if (typeof createImageBitmap !== "function") {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return createImageBitmap(await response.blob(), {
    imageOrientation: "none",
    premultiplyAlpha: "none",
    colorSpaceConversion: "none"
  });
}

/** The largest texture source that fits within the GPU's texture size limit. */
export function pickTextureSource(sources, maxTextureSize) {
  return sources.find((source) => source.width <= maxTextureSize) ?? sources.at(-1);
}

function compileProgram(gl, vertexSource, fragmentSource, prelude = "", define = "") {
  const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const vertexHeader = webgl2 ? "#version 300 es\n#define attribute in\n#define varying out\n" : "";
  const fragmentHeader = webgl2
    ? "#version 300 es\nprecision highp float;\n#define varying in\n#define texture2D texture\n#define gl_FragColor fragColor\nout vec4 fragColor;\n"
    : [
      "#extension GL_OES_standard_derivatives : enable",
      "#ifdef GL_EXT_shader_texture_lod",
      "#extension GL_EXT_shader_texture_lod : enable",
      "#define textureGrad texture2DGradEXT",
      "#else",
      "#define textureGrad(map, uv, uvDx, uvDy) texture2D(map, uv)",
      "#endif",
      "#ifdef GL_FRAGMENT_PRECISION_HIGH",
      "precision highp float;",
      "#else",
      "precision mediump float;",
      "#endif",
      ""
    ].join("\n");
  const vertexPrelude = prelude || "const float PI = 3.141592653589793;\n";

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Earth shader failed to compile: ${message}`);
    }
    return shader;
  };

  const vertexShader = compile(gl.VERTEX_SHADER, `${vertexHeader}${vertexPrelude}\n${define}\n${vertexSource}`);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, `${fragmentHeader}${fragmentSource}`);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Earth shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }

  const uniforms = {};
  const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let index = 0; index < uniformCount; index += 1) {
    const { name } = gl.getActiveUniform(program, index);
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

/**
 * MapLibre custom layer that renders satellite imagery, the day/night cycle, city lights,
 * ocean sun glint, and a sun-lit atmosphere with a sidereal starfield on the GPU.
 */
export class EarthLayer {
  constructor({ solarPosition = getSolarPosition(), live = true } = {}) {
    this.id = EARTH_LAYER_ID;
    this.type = "custom";
    this.renderingMode = "2d";
    this.map = null;
    this.surfacePrograms = new Map();
    this.atmosphereProgram = null;
    this.groundProgram = null;
    this.textures = {};
    this.textureSizes = {};
    this.pendingImages = {};
    this.failed = false;
    this.setSun(solarPosition, { live });
  }

  setSun(solarPosition, { live = false } = {}) {
    this.solarPosition = solarPosition;
    this.live = live;
    this.sunUpdatedAt = performance.now();
    this.sunDirection = getSunDirection(solarPosition);
    this.siderealAngle = getSiderealAngle(solarPosition.date);
    this.map?.triggerRepaint();
  }

  onAdd(map, gl) {
    this.map = map;
    const mesh = createSphereMesh();
    this.indexCount = mesh.indices.length;
    this.meshBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
    const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    if (!webgl2) {
      // WebGL 1 needs these for the per-pixel texel footprint and gradient sampling (2 has them built in).
      gl.getExtension("EXT_shader_texture_lod");
      if (!gl.getExtension("OES_standard_derivatives")) {
        this.failed = true;
        console.warn("This GPU lacks shader derivatives; the globe renders without lighting effects.");
        return;
      }
    }

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    Object.entries(TEXTURES).forEach(([name, { sources }]) => {
      const { url } = pickTextureSource(sources, maxTextureSize);
      loadTextureImage(url).then(
        (image) => {
          if (!this.map) {
            image.close?.();
            return;
          }
          this.pendingImages[name] = image;
          this.map.triggerRepaint();
        },
        () => console.warn(`Globe texture ${url} could not be loaded; continuing without it.`)
      );
    });
  }

  onRemove(_map, gl) {
    this.surfacePrograms.forEach(({ program }) => gl.deleteProgram(program));
    [this.atmosphereProgram, this.groundProgram].forEach((entry) => entry && gl.deleteProgram(entry.program));
    this.atmosphereProgram = null;
    this.groundProgram = null;
    Object.values(this.textures).forEach((texture) => gl.deleteTexture(texture));
    Object.values(this.pendingImages).forEach((image) => image.close?.());
    [this.meshBuffer, this.indexBuffer, this.quadBuffer].forEach((buffer) => gl.deleteBuffer(buffer));
    this.surfacePrograms.clear();
    this.textures = {};
    this.textureSizes = {};
    this.pendingImages = {};
    this.map = null;
  }

  render(gl, args) {
    if (this.failed) return;
    try {
      this.#uploadPendingTextures(gl);
      this.#refreshLiveSun();
      this.#draw(gl, args);
    } catch (error) {
      // A broken GPU path must never take the rest of the map down with it.
      this.failed = true;
      console.error(error);
    }
  }

  #refreshLiveSun() {
    if (!this.live || performance.now() - this.sunUpdatedAt < LIVE_SUN_REFRESH_MS) return;
    this.solarPosition = getSolarPosition();
    this.sunUpdatedAt = performance.now();
    this.sunDirection = getSunDirection(this.solarPosition);
    this.siderealAngle = getSiderealAngle(this.solarPosition.date);
  }

  #uploadPendingTextures(gl) {
    Object.entries(this.pendingImages).forEach(([name, image]) => {
      const format = gl[TEXTURES[name].format];
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, format, format, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.anisotropy) {
        const limit = gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(MAX_ANISOTROPY, limit));
      }
      this.textures[name] = texture;
      this.textureSizes[name] = [image.width, image.height];
      image.close?.();
    });
    this.pendingImages = {};
  }

  #meshProgram(gl, shaderData) {
    let program = this.surfacePrograms.get(shaderData.variantName);
    if (!program) {
      program = compileProgram(
        gl,
        SURFACE_VERTEX_SHADER,
        MESH_FRAGMENT_SHADER,
        shaderData.vertexShaderPrelude,
        shaderData.define
      );
      this.surfacePrograms.set(shaderData.variantName, program);
    }
    return program;
  }

  #draw(gl, args) {
    const projection = args.defaultProjectionData;
    const globe = args.shaderData.define.includes("GLOBE");
    const globeness = globe ? projection.projectionTransition : 0;
    const settings = getEarthLayerSettings(this.map.getZoom(), globeness);
    const eye = globeness > 0 ? getCameraPosition(projection.mainMatrix) : null;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (globe) {
      this.#drawMesh(gl, args, settings, eye);
    } else {
      this.#drawGround(gl, args, settings);
    }
    if (eye && settings.atmosphere > 0.001) {
      this.#drawAtmosphere(gl, args, settings, eye);
    }
  }

  #setShadingUniforms(gl, uniforms, settings, eye) {
    Object.entries(TEXTURES).forEach(([name, { unit }]) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[name] ?? null);
      gl.uniform1i(uniforms[`u_${name}`], unit);
    });
    const ready = (name) => (this.textures[name] ? 1 : 0);
    gl.uniform3f(uniforms.u_sun, ...this.sunDirection);
    gl.uniform3f(uniforms.u_eye, ...(eye ?? [0, 0, 0]));
    gl.uniform1f(uniforms.u_imagery, settings.imagery * ready("day"));
    gl.uniform1f(uniforms.u_lights, ready("night"));
    gl.uniform2f(uniforms.u_night_size, ...(this.textureSizes.night ?? [1, 1]));
    gl.uniform1f(uniforms.u_pixel_ratio, gl.drawingBufferWidth / Math.max(1, this.map.getCanvas().clientWidth));
    gl.uniform1f(uniforms.u_glint, eye ? settings.glint * ready("water") : 0);
    gl.uniform1f(uniforms.u_max_darkness, settings.maxDarkness);
  }

  #drawMesh(gl, args, settings, eye) {
    const projection = args.defaultProjectionData;
    const { program, uniforms } = this.#meshProgram(gl, args.shaderData);
    gl.useProgram(program);

    gl.uniformMatrix4fv(uniforms.u_projection_matrix, false, new Float32Array(projection.mainMatrix));
    if (uniforms.u_projection_fallback_matrix) {
      gl.uniformMatrix4fv(uniforms.u_projection_fallback_matrix, false, new Float32Array(projection.fallbackMatrix));
    }
    if (uniforms.u_projection_tile_mercator_coords) {
      gl.uniform4f(uniforms.u_projection_tile_mercator_coords, ...projection.tileMercatorCoords);
    }
    if (uniforms.u_projection_clipping_plane) {
      gl.uniform4f(uniforms.u_projection_clipping_plane, ...projection.clippingPlane);
    }
    if (uniforms.u_projection_transition) {
      gl.uniform1f(uniforms.u_projection_transition, projection.projectionTransition);
    }
    this.#setShadingUniforms(gl, uniforms, settings, eye);

    const location = gl.getAttribLocation(program, "a_lnglat");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(location);
  }

  #drawGround(gl, args, settings) {
    const ground = getLocalGroundProjection(args.defaultProjectionData.mainMatrix);
    if (!ground) return;
    this.groundProgram ??= compileProgram(gl, SCREEN_VERTEX_SHADER, GROUND_FRAGMENT_SHADER);
    const { program, uniforms } = this.groundProgram;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.u_inverse_local, false, new Float32Array(ground.inverseLocal));
    gl.uniform2f(uniforms.u_origin, ...ground.origin);
    this.#setShadingUniforms(gl, uniforms, settings, null);
    this.#drawScreenQuad(gl, program);
  }

  #drawScreenQuad(gl, program) {
    const location = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(location);
  }

  #drawAtmosphere(gl, args, settings, eye) {
    this.atmosphereProgram ??= compileProgram(gl, SCREEN_VERTEX_SHADER, ATMOSPHERE_FRAGMENT_SHADER);
    const { program, uniforms } = this.atmosphereProgram;
    const matrix = args.defaultProjectionData.mainMatrix;
    gl.useProgram(program);
    gl.uniform4f(uniforms.u_row_x, ...matrixRow(matrix, 0));
    gl.uniform4f(uniforms.u_row_y, ...matrixRow(matrix, 1));
    gl.uniform4f(uniforms.u_row_w, ...matrixRow(matrix, 3));
    gl.uniform3f(uniforms.u_eye, ...eye);
    gl.uniform3f(uniforms.u_sun, ...this.sunDirection);
    gl.uniform1f(uniforms.u_strength, settings.atmosphere);
    gl.uniform1f(uniforms.u_pixel_angle, args.fov / gl.drawingBufferHeight);
    gl.uniform1f(uniforms.u_sidereal, this.siderealAngle);
    this.#drawScreenQuad(gl, program);
  }
}
