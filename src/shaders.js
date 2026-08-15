// GLSL ES 1.00 so one shader pair works on both WebGL1 and WebGL2 contexts.
//
// Sand is drawn as a MASS, not as grains. The physics grain is 10-16 px across
// — far too big to be a grain of sand, and any renderer that gives it a shape of
// its own ends up drawing gravel, popcorn or beads. So the grains are never
// drawn directly:
//
//   1. Field pass — every grain splats a soft blob into an offscreen buffer,
//      summed. That gives a smooth coverage field (how much sand is in front of
//      each pixel), plus the sim's bed-level light and speed carried along as
//      weighted averages.
//   2. Composite — the level set of that field is the silhouette, its gradient
//      shades the surface, and the light channel colours it. Nothing here knows
//      what a grain is; the pile is one continuous matte body, which is what
//      sand looks like at arm's length.
//   3. Speck pass — the *grain* of the sand comes from tiny independent specks,
//      a few per physics grain, drawn as their own points on top. They are real
//      particles that ride the sim, so texture moves exactly with the sand.
//
// The reason the split works: nothing in (1) or (2) has structure at the physics
// grain scale, and the specks in (3) are far too small and sparse to reveal
// which grain they belong to. The eye is left with two honest scales — the
// mass and the speck — with nothing lumpy in between.

// -------------------------------------------------------------- field pass

export const SAND_FIELD_VERTEX = `
precision highp float;

attribute vec3 aPos;      // sim position: x,y CSS px, z depth (0 = glass)
attribute vec3 aShade;    // x: surface light, y: normalised speed, z: looseness
attribute vec2 aJitter;   // x: radius / mean radius, y: airborne (touching nothing)

uniform vec2 uViewport;   // CSS px
uniform float uFocal;     // focal length in CSS px
uniform vec2 uEye;        // projection centre in CSS px (parallax lives here)
uniform float uPointSize; // blob diameter for a mean grain, in field px
uniform float uDepthRange;
uniform float uDepthWeight;
uniform float uDepthDim;
uniform float uLooseShrink;
uniform float uGain;      // peak of a packed grain's blob
uniform float uBlob;      // blob radius as a multiple of the grain radius
uniform float uThreshold; // worst-case coverage the composite calls "sand"
uniform float uSoloSize;  // where a lone grain's level set lands, in radii

varying float vLight;
varying float vSpeed;
varying float vWeight;
varying float vAir;

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 p = uEye + (aPos.xy - uEye) * persp;
  vec2 unit = p / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  // A loosely held grain draws a *narrower* blob than a packed one. Blobs wide
  // enough to smooth the packed surface otherwise bridge the gap to a grain
  // that is barely attached and draw it as a drip hanging off the mass; a
  // narrow blob can only reach as far as it is wide.
  float loose = aShade.z;
  float shrink = 1.0 - uLooseShrink * loose;
  gl_PointSize = uPointSize * aJitter.x * persp * shrink;

  float depth = clamp(aPos.z / uDepthRange, 0.0, 1.0);
  // The back of the box falls into shadow, and a deep grain also counts for
  // less in the sum: the front layer is what the eye sees against the glass,
  // so it should dominate the averages.
  vLight = aShade.x * (1.0 - uDepthDim * depth);
  vSpeed = aShade.y;

  // Two regimes, blended by whether the grain has anything to overlap with.
  //
  // A grain in the mass contributes a moderate blob and the surface is built
  // out of hundreds of them summing together, so its own peak hardly matters.
  // ('packed' is a reserved word in GLSL ES — hence 'bulk'.)
  //
  // A grain touching NOTHING has to clear the threshold by itself or it is not
  // drawn at all, and with a fixed peak it usually could not: measured, 75% of
  // the grains in a splash rendered as literally nothing, every one of them
  // past the front of the box, because the depth weighting alone put them
  // under the threshold. So it gets exactly the peak that lands its level set
  // on uSoloSize of its own radius, with no depth attenuation — sand thrown at
  // the back of the box is still sand.
  //
  // Solving for the peak rather than turning the gain up is what keeps this
  // safe: a narrow blob with a tall peak is a compact dot that cannot bridge
  // to anything, and because uSoloSize sits inside the blob radius the peak
  // needed stays low enough that several may overlap before the 8-bit field
  // clips (measured max 170/255 through a splash, nothing clipped).
  //
  // Gated on *airborne*, not on looseness. A surface grain is under-coordinated
  // by definition — four contacts instead of six — and blending it toward the
  // solo peak bulges it out of the surface as its own lump, which fringes the
  // whole bed with grain-sized nubs: exactly the scale the field render exists
  // to hide.
  float bulk = uGain * (1.0 - uDepthWeight * depth);
  float rn = min(uSoloSize / (uBlob * shrink), 0.95);
  float e = 1.0 - rn * rn;
  float solo = uThreshold / max(e * e, 1e-3);
  vWeight = mix(bulk, max(bulk, solo), aJitter.y);
  vAir = aJitter.y;
}
`;

export const SAND_FIELD_FRAGMENT = `
precision mediump float;

varying float vLight;
varying float vSpeed;
varying float vWeight;
varying float vAir;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  // Squared falloff: overlapping blobs merge without a seam, and the sum
  // still keeps an edge instead of fogging outward. vWeight is the peak the
  // vertex shader solved for — gain and depth are already folded in.
  float w = 1.0 - r2;
  w = w * w;
  float t = w * vWeight;
  // R: coverage. G, B, A: coverage weighted by light, speed and airborne-ness,
  // so the composite can divide them back out as per-pixel averages. The
  // airborne channel is what lets it soften flying sand without knowing
  // anything about grains.
  gl_FragColor = vec4(t, t * vLight, t * vSpeed, t * vAir);
}
`;

// ---------------------------------------------------------------- composite

export const SAND_COMPOSITE_VERTEX = `
precision highp float;
attribute vec2 aCorner;
varying vec2 vUV;
void main() {
  vUV = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}
`;

export const SAND_COMPOSITE_FRAGMENT = `
precision mediump float;

varying vec2 vUV;

uniform sampler2D uField;
uniform vec2 uTexel;
uniform float uDpr;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLit;
uniform float uSurface;    // coverage at which sand starts
uniform float uSoft;       // width of the anti-aliased edge
uniform float uDither;     // how far the threshold wanders, grain to grain
uniform float uDitherPx;   // size of one such grain on screen (CSS px)
uniform float uRelief;     // how strongly the coverage gradient tilts the normal
uniform float uForm;       // how much that shading is allowed to do
uniform float uPale;       // fast sand pales toward dust
uniform float uPatchScale;
uniform float uPatchAmp;
uniform float uGrainPx;    // grain relief: cell size on screen (CSS px)
uniform float uGrainAmp;   // and its contrast
uniform float uAirSoft;    // how much wider the edge band gets for flying sand
uniform float uAirLight;   // ceiling on the colour ramp for flying sand

float phash(vec2 c) {
  return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453);
}

// Slow spatial variation — real sand varies in patches (minerals, moisture),
// not grain by grain. Value noise, bilinearly smoothed.
float patch(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(phash(i), phash(i + vec2(1.0, 0.0)), f.x),
    mix(phash(i + vec2(0.0, 1.0)), phash(i + vec2(1.0, 1.0)), f.x),
    f.y);
}

void main() {
  vec4 f = texture2D(uField, vUV);
  float w = f.r;

  // Sand in flight gets a soft, porous edge instead of the mass's tight one.
  // A grain alone in the air has a steep blob and nothing to overlap, so its
  // level set is a clean circle that the threshold dither barely moves —
  // measured, under a pixel — which draws a splash as a scatter of smooth
  // peas. Widening the band turns each into a puff that fades out, and the
  // specks riding on it supply the grain.
  float air = clamp(f.a / max(w, 1e-4), 0.0, 1.0);
  float soft = uSoft * mix(1.0, uAirSoft, air);

  // Most of the screen is empty box; leave before doing any noise for it. The
  // bound has to allow for the widened band above, or it clips the very
  // falloff that softens the splash.
  if (w < uSurface - uDither * 0.5 - soft) discard;
  vec2 css = gl_FragCoord.xy / uDpr;

  // The level set of the coverage field is the silhouette. A clean contour
  // reads as clay, so the threshold wanders at grain scale across the screen:
  // the edge breaks into fuzz, the way a real pile of sand never has a smooth
  // outline. Smooth noise rather than cells, or the fuzz is square-cornered.
  float wander = patch(css / uDitherPx) - 0.5;
  float thr = uSurface + wander * uDither;
  float mask = smoothstep(thr - soft, thr + soft, w);
  if (mask <= 0.004) discard;

  float light = f.g / max(w, 1e-4);
  float speed = f.b / max(w, 1e-4);

  // A grain in the air is fully exposed, but that is not the same as being the
  // sunlit crest of a pile. The top of the ramp is a pale cream, earned by a
  // whole surface catching the light across its face; a lone grain gathers
  // nothing like it, and drawn there — pale, soft-edged and round — it reads
  // as a glowing bead rather than as a fleck of sand.
  light = mix(light, min(light, uAirLight), air);

  // Form shading from the coverage gradient, confined to the band along the
  // free surface, and brighten-only: a crest facing the light catches it, but
  // a slope facing away is left alone. Darkening the lee side as well drew a
  // dark rim a few pixels wide along every shadowed edge, which reads as an
  // outline rather than as shade — the gradient only exists in the edge band,
  // so it can never darken a whole face the way real shadow would.
  //
  // The packed interior is exempt too — its field is a sum of overlapping
  // blobs and never quite flat, and shading that gradient embosses every
  // grain back into the mass as a soft bump.
  float l = texture2D(uField, vUV - vec2(uTexel.x, 0.0)).r;
  float r = texture2D(uField, vUV + vec2(uTexel.x, 0.0)).r;
  float d = texture2D(uField, vUV - vec2(0.0, uTexel.y)).r;
  float u = texture2D(uField, vUV + vec2(0.0, uTexel.y)).r;
  float band = 1.0 - smoothstep(uSurface * 1.5, uSurface * 4.0, w);
  float relief = uRelief * band;
  // +y is up the screen here.
  vec3 nrm = normalize(vec3((l - r) * relief, (d - u) * relief, 1.0));
  vec3 lightDir = normalize(vec3(-0.35, 0.62, 0.70));
  float diffuse = max(dot(nrm, lightDir), 0.0);
  float form = 1.0 + uForm * max(diffuse / lightDir.z - 1.0, 0.0);

  vec3 c = mix(uDeep, uMid, smoothstep(0.0, 0.55, light));
  c = mix(c, uLit, smoothstep(0.45, 1.0, light));
  // Airborne dust catches the light and pales, but never glows.
  c = mix(c, vec3(0.97, 0.94, 0.86), clamp(speed, 0.0, 1.0) * uPale);
  c *= 1.0 - uPatchAmp + uPatchAmp * 2.0 * patch(css / uPatchScale);
  c *= form;

  // Grain relief. Real sand is grains all the way down, each with a lit side
  // and a shadowed side, and it is that fine agreeing relief — not random
  // brightness — that reads as sand rather than as felt. Embossed value noise
  // at grain scale: the difference between the noise here and the noise one
  // step toward the light is a lit slope where it rises and a shadow where it
  // falls. It is screen-anchored, so it fades out wherever the sand is
  // moving: still sand keeps its grain, flowing sand blurs — which is also
  // what a camera would show — and the specks carry the motion.
  vec2 gp = css / uGrainPx;
  float relief2 = patch(gp) - patch(gp + vec2(-0.5, 0.5));
  float still = 1.0 - smoothstep(0.03, 0.2, speed);
  c *= 1.0 + uGrainAmp * relief2 * 2.0 * still;

  gl_FragColor = vec4(c, mask);
}
`;

// --------------------------------------------------------------- speck pass

export const SPECK_VERTEX = `
precision highp float;

attribute vec3 aPos;      // speck position, CSS px + depth
attribute vec4 aData;     // x: light, y: tone, z: size ratio, w: phase
attribute vec2 aMotion;   // x: normalised speed, y: airborne

uniform vec2 uViewport;
uniform float uFocal;
uniform vec2 uEye;
uniform float uPointSize; // speck diameter in device px
uniform float uDepthRange;
uniform float uDepthDim;
uniform float uAirLight;

varying float vLight;
varying float vTone;
varying float vPhase;
varying float vSpeed;
varying float vDepth;
varying float vAir;

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 p = uEye + (aPos.xy - uEye) * persp;
  vec2 unit = p / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  gl_PointSize = uPointSize * aData.z * persp;
  float depth = clamp(aPos.z / uDepthRange, 0.0, 1.0);
  // Sand in the air is not the sunlit crest of a pile — see the composite,
  // which caps the ramp the same way. Without it a flying grain's specks come
  // out as the palest cream in the palette and read as sparks.
  float lit = aData.x;
  lit = mix(lit, min(lit, uAirLight), aMotion.y);
  vLight = lit * (1.0 - uDepthDim * depth);
  vTone = aData.y;
  vPhase = aData.w;
  vSpeed = aMotion.x;
  vAir = aMotion.y;
  vDepth = depth;
}
`;

export const SPECK_FRAGMENT = `
precision mediump float;

varying float vLight;
varying float vTone;
varying float vPhase;
varying float vSpeed;
varying float vDepth;
varying float vAir;

uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLit;
uniform float uAlpha;
uniform float uDepthFade;
uniform float uGlint;
uniform float uGlintRate;
uniform float uTime;
uniform sampler2D uField;
uniform vec2 uInvCanvas;  // 1 / canvas size in device px
uniform float uSurface;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  // A speck belongs to the mass it sits on: past the silhouette it fades, so
  // grains at the surface fringe it with texture rather than hovering beside
  // it as loose dots.
  //
  // Sand in flight is exempt. Its grain has no mass to belong to, and the
  // whole point of it is that the specks — not the field — are what draw it:
  // a physics grain is 20 px across, and filling that with one smooth blob
  // gives a bead, while scattering it with specks gives the porous clump that
  // flying sand actually is.
  float cover = texture2D(uField, gl_FragCoord.xy * uInvCanvas).r;
  float onSand = max(smoothstep(uSurface * 0.55, uSurface * 1.3, cover), vAir);
  float a = smoothstep(1.0, 0.55, r2) * uAlpha * (1.0 - uDepthFade * vDepth) * onSand;
  if (a < 0.01) discard;

  vec3 c = mix(uDeep, uMid, smoothstep(0.0, 0.55, vLight));
  c = mix(c, uLit, smoothstep(0.45, 1.0, vLight));
  c *= vTone;

  // Only the bright quartz specks ever glint (tone above 1), briefly and out
  // of phase with each other, and more readily while the sand is moving and
  // the facets are tumbling.
  float bright = step(1.12, vTone);
  float tw = sin(uTime * uGlintRate + vPhase * 6.2831853);
  c += vec3(1.0, 0.97, 0.9) * pow(max(tw, 0.0), 48.0) * uGlint * bright
    * (0.35 + 0.65 * clamp(vLight, 0.0, 1.0)) * (0.5 + vSpeed);

  gl_FragColor = vec4(c, a);
}
`;

// ---------------------------------------------------------------- the box
//
// Interior walls and back plane, drawn before the sand in the same pinhole
// projection. Without them the container is invisible and the eye has to infer
// a box from the sand alone — which is why the depth read as flat no matter how
// many layers were behind the glass. Because the front rectangle sits exactly
// on the viewport edge (persp is 1 at z=0, parallax included), only the back
// moves: tilting shears the walls, which is the strongest depth cue here.

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
