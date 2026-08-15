// GLSL ES 1.00 so one shader pair works on both WebGL1 and WebGL2 contexts.
//
// Each physics grain is one point sprite, and the sprite draws a small *cluster*
// of matte specks rather than a single lit ball — visual grain size is decoupled
// from physics grain size, so the sand renders several times finer than the
// solver's grains for free.
//
// The look aims at real dry quartz sand, and almost all of it is micro-relief:
// every speck gets a lit side and a shadowed side from one global light, and
// the webbing between specks falls into crevice shadow. Thousands of tiny
// highlights and shadows all agreeing about the light direction is what reads
// as "sand"; per-speck random brightness alone reads as static. On top of that
// sits the bed-level light field computed in the sim (vLight: open surface vs
// buried), which gives the pile its solid, three-dimensional mass.

export const VERTEX_SHADER = `
precision highp float;

attribute vec3 aPos;      // sim position: x,y CSS px, z depth (0 = glass)
attribute vec3 aShade;    // x: surface light, y: normalised speed, z: airborne
attribute vec2 aJitter;   // x: cluster seed, y: tint variation

uniform vec2 uViewport;   // CSS px
uniform float uPointSize; // device px, already scaled by dpr
uniform float uAirShrink;
uniform float uFocal;     // focal length in CSS px
uniform vec2 uEye;        // projection centre in CSS px (parallax lives here)
uniform float uDepthRange;
uniform float uPatchScale;

varying float vLight;
varying float vSpeed;
varying float vAir;
varying float vTint;
varying float vDepth;
varying float vSeed;
varying float vPatch;

float phash(vec2 c) {
  return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 projected = uEye + (aPos.xy - uEye) * persp;
  vec2 unit = projected / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  // Airborne grains keep their sprite: the fragment shader draws them as one
  // grain-sized speck instead of a cluster, so the size must stay honest.
  float shrink = 1.0 - uAirShrink * aShade.z;
  // aJitter.x is the grain's physical radius ratio, so the sprite matches the
  // polydisperse physics exactly.
  gl_PointSize = uPointSize * aJitter.x * shrink * persp;
  vLight = aShade.x;
  vSpeed = aShade.y;
  vAir = aShade.z;
  vTint = aJitter.y;
  vDepth = clamp(aPos.z / uDepthRange, 0.0, 1.0);
  vSeed = aJitter.x;

  // Slow spatial variation — real sand varies in patches (minerals, moisture),
  // not grain-by-grain. Value noise over world position, bilinearly smoothed
  // so a grain drifting across a patch boundary fades rather than pops.
  vec2 p = aPos.xy / uPatchScale;
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float n = mix(
    mix(phash(i), phash(i + vec2(1.0, 0.0)), f.x),
    mix(phash(i + vec2(0.0, 1.0)), phash(i + vec2(1.0, 1.0)), f.x),
    f.y);
  vPatch = n;
}
`;

/**
 * The speck count has to be a compile-time constant: GLSL ES 1.00 only allows
 * loops with constant bounds.
 */
export function buildFragmentShader(speckCount) {
  return `
precision highp float;

#define SPECKS ${Math.max(1, Math.round(speckCount))}

varying float vLight;
varying float vSpeed;
varying float vAir;
varying float vTint;
varying float vDepth;
varying float vSeed;
varying float vPatch;

uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLit;
uniform float uDepthDim;  // how much the back of the box falls into shadow
uniform float uSpread;    // how far specks scatter across the sprite
uniform float uSpeck;     // speck radius in the packed bed, sprite units
uniform float uAirSpeck;  // speck radius for an isolated grain, sprite units
uniform float uVary;      // matte brightness spread between specks
uniform float uPatchAmp;  // strength of the spatial patchiness
uniform float uGlint;     // sparkle strength
uniform float uGlintRate;
uniform float uTime;

// Hashes (Dave Hoskins). Stable per sprite, so the cluster travels rigidly
// with its grain the way a real clump does.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec2 hash21(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 grainColor() {
  float t = clamp(vLight, 0.0, 1.0);
  vec3 c = mix(uDeep, uMid, smoothstep(0.0, 0.55, t));
  c = mix(c, uLit, smoothstep(0.45, 1.0, t));
  // Airborne dust catches the light and pales, but never glows.
  c = mix(c, vec3(0.97, 0.94, 0.86), clamp(vSpeed, 0.0, 1.0) * 0.35);
  c *= 0.94 + 0.12 * vTint;
  c *= 1.0 - uPatchAmp + uPatchAmp * 2.0 * vPatch;
  return c;
}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // A packed grain spreads its specks across the sprite; a grain touching
  // nothing draws as a single speck instead — otherwise every airborne grain
  // reads as a little flower of specks stuck together, which the cluster trick
  // hides inside the bed but not in flight.
  //
  // Keyed on isolation, not speed: a speed threshold fires on any grain that
  // has fallen a few tens of pixels, so a whole bed in motion collapses and
  // reads as drifting dust rather than sand.
  //
  // The lone speck grows to the grain's *actual* size (uAirSpeck). Collapsing
  // to the fine bed-speck size instead leaves a flying grain drawn several
  // times smaller than it physically is — thousands of those is exactly what a
  // dust cloud looks like, even when the simulation is behaving perfectly.
  float spread = uSpread * (1.0 - 0.85 * vAir);
  float speck = mix(uSpeck, uAirSpeck, vAir);

  // Nearest speck in the cluster.
  float best = 10.0;
  float bestId = 0.0;
  vec2 bestC = vec2(0.0);
  for (int k = 0; k < SPECKS; k++) {
    float fk = float(k);
    vec2 c = (hash21(vSeed * 17.0 + fk * 3.71) - 0.5) * spread;
    float d = length(uv - c);
    if (d < best) {
      best = d;
      bestId = fk;
      bestC = c;
    }
  }

  // Coverage runs a little past the specks so neighbours web together into a
  // porous but connected mass; what shows through the gaps is the grain drawn
  // behind, which is deeper and darker — free crevices.
  float alpha = smoothstep(speck * 2.1, speck * 1.1, best)
    * smoothstep(1.0, 0.8, r2);
  if (alpha < 0.02) discard;

  vec3 color = grainColor();

  // Micro-relief: a gentle fake normal per speck, all lit by the same global
  // light. Lit crest up-left, shade down-right, crevice shadow in the webbing.
  vec2 local = (uv - bestC) / max(speck, 1e-3);
  float lz = sqrt(max(1.0 - min(dot(local, local), 1.0) * 0.75, 0.0));
  vec3 nrm = normalize(vec3(local.x, local.y, lz * 1.35));
  vec3 lightDir = normalize(vec3(-0.33, -0.62, 0.71));
  float diffuse = max(dot(nrm, lightDir), 0.0);
  float crevice = smoothstep(speck * 2.0, speck * 0.5, best);
  color *= (0.52 + 0.62 * diffuse) * (0.55 + 0.45 * crevice);

  // A touch of per-speck scatter on top — grains are not all one mineral.
  color *= 1.0 - uVary * 0.5 + uVary * hash11(vSeed * 5.3 + bestId * 2.17);
  color *= 1.0 - uDepthDim * vDepth;

  // Sparkle: dry sand glints as facets catch the sun — but only the odd
  // facet. Most specks never glint at all; letting every speck flash on a
  // cycle made the whole bed shimmer like glitter.
  float facet = step(0.85, hash11(vSeed * 31.7 + bestId * 7.77));
  float phase = hash11(vSeed * 9.1 + bestId * 4.3);
  float tw = sin(uTime * uGlintRate + phase * 6.2831853);
  color += vec3(1.0, 0.97, 0.9) * pow(max(tw, 0.0), 64.0) * uGlint * facet
    * (0.3 + 0.7 * clamp(vLight, 0.0, 1.0)) * diffuse;

  gl_FragColor = vec4(color, alpha);
}
`;
}

// The box itself: interior walls and back plane, drawn before the sand in the
// same pinhole projection.
//
// Without them the container is invisible and the eye has to infer a box from
// loose grains alone — which is why the depth read as flat no matter how many
// layers were behind the glass. Four trapezoids converging on an inset back
// rectangle give the eye a reference frame, and because the front rectangle sits
// exactly on the viewport edge (persp is 1 at z=0, parallax included), only the
// back moves: tilting shears the walls, which is the strongest depth cue here.

export const WALL_VERTEX_SHADER = `
precision highp float;

attribute vec3 aPos;
attribute float aShade;

uniform vec2 uViewport;
uniform float uFocal;
uniform vec2 uEye;

varying float vShade;

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 p = uEye + (aPos.xy - uEye) * persp;
  vec2 unit = p / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  vShade = aShade;
}
`;

export const WALL_FRAGMENT_SHADER = `
precision mediump float;
varying float vShade;
uniform vec3 uWallColor;
void main() {
  gl_FragColor = vec4(uWallColor * vShade, 1.0);
}
`;
