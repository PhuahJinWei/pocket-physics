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
uniform float uLooseShrink;
uniform float uBlob;      // blob radius as a multiple of the grain radius
uniform float uThreshold; // worst-case coverage the composite calls "sand"
uniform float uBulkSize;  // where a packed grain's level set lands, in radii
uniform float uAloneSize; // ... a grain resting by itself
uniform float uSoloSize;  // ... and one in flight
uniform float uAirPow;    // profile exponent for a lone grain (mass uses 2)
uniform float uAirLight;  // ceiling on the light ramp for sand in flight

varying float vLight;
varying float vSpeed;
varying float vDepth;
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
  float air = aJitter.y;
  float shrink = 1.0 - uLooseShrink * loose;
  gl_PointSize = uPointSize * aJitter.x * persp * shrink;

  float depth = clamp(aPos.z / uDepthRange, 0.0, 1.0);
  vDepth = depth;
  // A grain in the air is fully exposed, but that is not the same as being the
  // sunlit crest of a pile — the top of the ramp is a pale cream earned by a
  // whole surface catching the light. Capped here, before it is summed, so
  // the composite never has to know what is flying.
  float lit = aShade.x;
  vLight = mix(lit, min(lit, uAirLight), air);
  vSpeed = aShade.y;

  // Every grain's blob peak is SOLVED, so that alone it draws at a chosen
  // size. Handing grains a fixed peak and letting a threshold decide the size
  // is the same statement backwards, and it hides a trap: the size you get
  // then depends on how many other grains happen to overlap. A deep bed sums
  // twenty-odd blobs, so almost any peak looks right there — and a peak tuned
  // that way left a *single* grain unable to clear the threshold at all. It
  // never showed until the bed stopped being deep. Lay the phone flat and the
  // whole thing collapses into a sheet one grain thick across the entire
  // screen, where nothing overlaps enough, and the sand tears into holes.
  //
  // The size a grain draws at depends on how packed it is, and separately on
  // whether it is in flight. Three cases, and each earns its place:
  //
  //   packed, at rest -> uBulkSize, a little OUTSIDE its own radius.
  //              Deliberate: a physics grain stands in for a clump of real
  //              sand, and that sand fills its neighbourhood rather than an
  //              inscribed sphere, so a jammed monolayer reads as continuous.
  //   alone, at rest  -> uAloneSize, its own true size. A grain lying by
  //              itself in a bare patch is not spray — it is a grain of sand
  //              lying there, and it should look like one. Shrinking it is
  //              what left bare patches as clean empty holes with nothing
  //              scattered in them, which is not how sand ever looks.
  //   in flight       -> uSoloSize, well inside it, where the SPECKS take
  //              over. Drawn generously instead, sparse grains merge into
  //              rounded lobes and a splash turns to batter.
  //
  // One global threshold cannot do this — generous enough to close a monolayer
  // is generous enough to melt a splash — which is why it is per grain.
  //
  // Depth deliberately does not enter. Sand is opaque however deep it sits;
  // what changes with distance is colour, and that is the composite's job.
  //
  // Sand in flight also gets a gentler blob profile (uAirPow, against 2 for
  // the mass) so its coverage ramps over more pixels and the composite's soft
  // band lands as a porous puff rather than a hard-rimmed pea. The peak is
  // solved against whichever profile the grain is using.
  float target = mix(uBulkSize, uAloneSize, loose);
  target = mix(target, uSoloSize, air);
  float rn = min(target / (uBlob * shrink), 0.95);
  float e = 1.0 - rn * rn;
  float prof = mix(e * e, pow(e, uAirPow), air);
  vWeight = uThreshold / max(prof, 1e-3);
  vAir = air;
}
`;

export const SAND_FIELD_FRAGMENT = `
precision mediump float;

varying float vLight;
varying float vSpeed;
varying float vDepth;
varying float vWeight;
varying float vAir;

// Declared in both stages, and the two default to different precisions —
// GLSL treats that as two different uniforms and refuses to link.
uniform highp float uAirPow;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  // Squared falloff: overlapping blobs merge without a seam, and the sum
  // still keeps an edge instead of fogging outward. A lone grain in the air
  // gets a gentler falloff instead (see the vertex shader). vWeight is the
  // peak the vertex shader solved for — gain and depth are already folded in.
  float w = 1.0 - r2;
  float p = mix(w * w, pow(w, uAirPow), vAir);
  float t = p * vWeight;
  // R: coverage. G, B, A: coverage weighted by light, speed and depth, so the
  // composite can divide them back out as per-pixel averages.
  gl_FragColor = vec4(t, t * vLight, t * vSpeed, t * vDepth);
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
uniform float uFormRadius; // and how far apart it samples, in field texels
uniform float uEdgeRadius; // silhouette low-pass radius, in field texels
uniform float uEdgeSmooth; // how much of it the mask takes
uniform float uPale;       // fast sand pales toward dust
uniform float uPatchScale;
uniform float uPatchAmp;
uniform vec3 uFog;         // what the back of the box fades toward
uniform float uDepthDim;   // and how far it gets
uniform float uFogStart;   // depth (0..1) at which the fade begins

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
  float soft = uSoft;

  // Most of the screen is empty box; leave before doing any noise for it. The
  // margin covers the low-pass below, which can lift a pixel above threshold
  // that the raw field left under it.
  if (w < uSurface - uDither * 0.5 - soft - 0.03) discard;
  vec2 css = gl_FragCoord.xy / uDpr;

  // ---- silhouette
  //
  // The level set of the coverage field is the outline, and taken raw it
  // undulates at PHYSICS-GRAIN scale — it is the contour of a sum of blobs,
  // each 15-20 px across, so the edge carries lumps at exactly the size the
  // whole field render exists to hide. Fine dither cannot disguise them: it
  // works at 3 px and the lumps are five times that.
  //
  // So the mask comes from a WIDER average of the field. That is a low-pass
  // in image space: it removes structure at the blob scale and keeps the
  // shape of the pile, and the fine dither goes back on top so the edge is
  // still fuzz rather than a smooth contour. Sand has no outline; what it has
  // is a boundary that is uncertain at grain scale, which is a different
  // thing from one that is bumpy at clod scale.
  vec2 er = uTexel * uEdgeRadius;
  float ws = (
      texture2D(uField, vUV + vec2( er.x, 0.0)).r
    + texture2D(uField, vUV + vec2(-er.x, 0.0)).r
    + texture2D(uField, vUV + vec2(0.0,  er.y)).r
    + texture2D(uField, vUV + vec2(0.0, -er.y)).r) * 0.25;
  float wMask = mix(w, ws, uEdgeSmooth);

  float wander = patch(css / uDitherPx) - 0.5;
  float thr = uSurface + wander * uDither;
  float mask = smoothstep(thr - soft, thr + soft, wMask);
  if (mask <= 0.004) discard;

  float light = f.g / max(w, 1e-4);
  float speed = f.b / max(w, 1e-4);
  float depth = f.a / max(w, 1e-4);

  // ---- form
  //
  // Shading from the coverage gradient, sampled WIDE — several grains apart
  // rather than one texel. That distinction is the whole trick. One texel
  // apart the gradient is the noise of individual blobs, and lighting it
  // embosses every grain back into the mass as a soft bump; several grains
  // apart the blob noise averages out and what is left is the shape of the
  // pile itself — the slope of a free surface, the shoulder of a heap, the
  // hollow a finger left. That is the shading the mass was missing, and its
  // absence is why a bed with perfectly good grain texture still read as a
  // painted slab: real sand is lit by its own form first and its grain
  // second.
  //
  // It darkens as well as brightens, which the narrow version could not
  // afford: a one-texel gradient only exists within a few pixels of the
  // silhouette, so darkening it drew a dark rim that read as an outline. A
  // wide gradient spans a whole face, so shading it reads as shade.
  vec2 fr = uTexel * uFormRadius;
  float fl = texture2D(uField, vUV - vec2(fr.x, 0.0)).r;
  float fR = texture2D(uField, vUV + vec2(fr.x, 0.0)).r;
  float fd = texture2D(uField, vUV - vec2(0.0, fr.y)).r;
  float fu = texture2D(uField, vUV + vec2(0.0, fr.y)).r;
  // +y is up the screen here.
  vec3 nrm = normalize(vec3((fl - fR) * uRelief, (fd - fu) * uRelief, 1.0));
  vec3 lightDir = normalize(vec3(-0.35, 0.62, 0.70));
  // Normalised so a face square to the viewer is unshaded.
  float diffuse = max(dot(nrm, lightDir), 0.0) / lightDir.z;
  float form = mix(1.0, diffuse, uForm);

  vec3 c = mix(uDeep, uMid, smoothstep(0.0, 0.55, light));
  c = mix(c, uLit, smoothstep(0.45, 1.0, light));
  // Airborne dust catches the light and pales, but never glows.
  c = mix(c, vec3(0.97, 0.94, 0.86), clamp(speed, 0.0, 1.0) * uPale);
  // Patchiness stays screen-anchored on purpose, unlike the grain relief that
  // used to sit here. This one is only a slow brightness wash, and reads as
  // light and shade inside the box — which genuinely does not travel with the
  // sand. Fine relief is a different claim: it purports to BE the grains, so
  // it has to move with them, and it now lives on the specks instead.
  c *= 1.0 - uPatchAmp + uPatchAmp * 2.0 * patch(css / uPatchScale);
  c *= form;

  // Depth is a colour, never a coverage. The back of the box falls into
  // shadow, so sand there fades toward the box's own darkness — which reads as
  // *far*. Dimming its light instead read as *buried*: it slid the colour down
  // the ramp into crevice brown, and the band of sand visible only at the
  // back came out as a dark smear.
  //
  // The fog starts partway back rather than at the glass. The depth here is
  // an average along the view ray, so even the front face of the bed reads
  // as mid-depth once the grains behind it are summed in — fogging from zero
  // greyed the whole mass by a fifth (measured: 23% saturation against the
  // 35-45% of real dry sand). Only what is genuinely toward the back should
  // pay.
  float far = smoothstep(uFogStart, 1.0, clamp(depth, 0.0, 1.0));
  c = mix(c, uFog, uDepthDim * far);

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
  // Sand in the air is not the sunlit crest of a pile — see the field pass,
  // which caps the ramp the same way. Without it a flying grain's specks come
  // out as the palest cream in the palette and read as sparks.
  float lit = aData.x;
  vLight = mix(lit, min(lit, uAirLight), aMotion.y);
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
uniform vec3 uFog;
uniform float uDepthDim;
uniform float uFogStart;
uniform float uSpeckRelief; // strength of the per-speck lit/shadow side
uniform float uSpeckRound;  // how domed each speck is (higher = flatter)
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

  // Micro-relief: every speck is a little rounded grain with a lit crest and a
  // shadowed far side, all agreeing about one global light. This is the thing
  // that reads as sand rather than as felt or as static — thousands of tiny
  // highlights and shadows pointing the same way — and putting it HERE rather
  // than in the composite is what makes it honest: a speck is a particle that
  // rides the simulation, so its relief travels with the sand. The same relief
  // painted as screen-space noise stands still while the sand pours through
  // it, which is a tell you cannot unsee once you have looked for it.
  //
  // gl_PointCoord's y runs down the sprite, so the light vector is negated in
  // y against the composite's: crest up-left either way.
  vec3 lightDir = normalize(vec3(-0.33, -0.62, 0.71));
  vec3 nrm = normalize(vec3(uv, sqrt(max(1.0 - min(r2, 1.0), 0.0)) + uSpeckRound));
  // Normalised against a speck facing straight out, so relief REDISTRIBUTES
  // light rather than adding it: the crest brightens by as much as the far
  // side darkens, and the bed's overall tone is untouched. Scaling raw
  // diffuse instead lifts every speck centre by a fifth, which came out as
  // glitter lying on top of the sand rather than as the sand's own surface.
  float shade = max(dot(nrm, lightDir), 0.0) / lightDir.z;
  c *= mix(1.0, shade, uSpeckRelief);

  // Only the bright quartz specks ever glint (tone above 1), briefly and out
  // of phase with each other, and more readily while the sand is moving and
  // the facets are tumbling.
  float bright = step(1.12, vTone);
  float tw = sin(uTime * uGlintRate + vPhase * 6.2831853);
  c += vec3(1.0, 0.97, 0.9) * pow(max(tw, 0.0), 48.0) * uGlint * bright
    * (0.35 + 0.65 * clamp(vLight, 0.0, 1.0)) * (0.5 + vSpeed);

  // Same fog as the mass, so a speck at the back sits *in* the sand behind
  // it rather than on top of it.
  c = mix(c, uFog, uDepthDim * smoothstep(uFogStart, 1.0, vDepth));

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

// ---------------------------------------------------------------- marbles
//
// Marbles are the one material NOT drawn as a mass. Sand and the liquids are
// fields because their particles must not be visible; a marble IS the object,
// so it gets drawn as itself — one point sprite per marble, shaded as a glass
// sphere.
//
// The sprite is a billboard, and the sphere is entirely in the fragment shader:
// the normal comes from the sprite's own coordinates, which is exact for a
// sphere and costs nothing. Three things then do the work of saying "glass":
// a tight specular highlight, a Fresnel rim that brightens toward the
// silhouette, and — the one that actually sells it — a bright spot on the side
// AWAY from the light, because a glass sphere is a lens and focuses what passes
// through it. Without that last term the same shader reads as a snooker ball.
//
// Note it never rotates, and cannot: the solver has no rotational degree of
// freedom. That is invisible here only because the shading is radially
// symmetric about the light rather than painted on the surface — the moment a
// marble gets a swirl or a stripe, the missing spin becomes obvious.
export const MARBLE_VERTEX = `
precision highp float;

attribute vec3 aPos;    // marble centre, CSS px + depth
attribute vec4 aData;   // x: size ratio, y: hue, z: speed, w: burial light
attribute vec4 aSpin;   // orientation quaternion, xyzw

uniform vec2 uViewport;
uniform float uFocal;
uniform vec2 uEye;
uniform float uPointSize;   // marble diameter in device px
uniform float uDepthRange;
uniform float uMaxPoint;    // hardware ceiling on gl_PointSize

varying float vHue;
varying float vDepth;
varying float vSpeed;
varying float vLight;
varying vec4 vSpin;

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 p = uEye + (aPos.xy - uEye) * persp;
  vec2 unit = p / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  // Clamped, because a marble sprite is far larger than a speck and drivers
  // differ on how big a point may be. Past the ceiling the sprite silently
  // stops growing, which is a wrong size rather than a missing marble.
  gl_PointSize = min(uPointSize * aData.x * persp, uMaxPoint);
  vHue = aData.y;
  vDepth = clamp(aPos.z / uDepthRange, 0.0, 1.0);
  vSpeed = aData.z;
  vLight = aData.w;
  vSpin = aSpin;
}
`;

export const MARBLE_FRAGMENT = `
precision highp float;

varying float vHue;
varying float vDepth;
varying float vSpeed;
varying float vLight;
varying vec4 vSpin;

uniform float uIor;        // ratio n_air / n_glass, so ~0.66
uniform vec3 uInterior;    // what shows THROUGH: the dark of the box behind
uniform vec3 uSky;         // reflected environment, above the horizon
uniform vec3 uGround;      // and below it
uniform vec2 uUp;          // world up in screen space, from the tilt
uniform float uPitch;      // how far face-up the device is held
uniform float uEnvSharp;
uniform float uLampAt;
uniform float uLampWidth;
uniform float uLampGain;
uniform float uSaturation;
uniform float uBodyTint;   // colour wash through the whole body
uniform float uCoreGain;   // brightness of the dense knot at the centre
uniform float uCore;       // core radius, fraction of the marble
uniform float uCoreSoft;
uniform float uVane;
uniform float uVaneWidth;  // vane disc radius
uniform float uVaneTint;
uniform float uSpecular;
uniform float uSpecPower;
uniform float uBurial;     // how much a buried marble darkens
uniform vec3 uFog;
uniform float uDepthDim;
uniform float uFogStart;

// Rotate a vector by a quaternion. Used with the CONJUGATE below, to carry the
// surface normal from the screen back into the marble's own frame — which is
// what lets a mark stay painted on the glass while the glass turns.
vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// Hue to RGB, so one float per marble buys the whole jar of colours.
vec3 hue2rgb(float h) {
  vec3 k = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
  vec3 p = abs(fract(vec3(h) + k) * 6.0 - 3.0);
  return clamp(p - 1.0, 0.0, 1.0);
}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float zc = sqrt(max(1.0 - r2, 0.0));
  // gl_PointCoord runs DOWN the sprite; negate so +y is up the screen and this
  // light agrees with every other pass.
  vec3 nrm = vec3(uv.x, -uv.y, zc);
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 lightDir = normalize(vec3(-0.40, 0.55, 0.73));

  // Glass is a Fresnel mix of what it REFLECTS and what it TRANSMITS, and
  // almost none of it is diffuse. Shading a marble with Lambert and an ambient
  // term is what makes it read as clay: a diffuse ball is the same brightness
  // whichever way you look at it, where glass is nearly black head-on and a
  // mirror at the edges. Schlick, with F0 = 0.04 for glass against air.
  float cosT = clamp(zc, 0.0, 1.0);
  float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);

  // ---- what it transmits
  //
  // The ray bends on the way in, and everything inside is seen ALONG THAT BENT
  // RAY. That is the whole reason a marble's core looks magnified and swims as
  // you turn it; a flat disc painted on the sprite cannot do either.
  vec3 rd = refract(-view, nrm, uIor);
  vec3 p = nrm;                       // entry point on the unit sphere

  // The core is a real sphere at the centre, so the test is the distance from
  // the centre to the refracted ray.
  float tc = -dot(p, rd);
  float dCore = length(p + rd * tc);
  float core = 1.0 - smoothstep(uCore - uCoreSoft, uCore + uCoreSoft, dCore);

  vec3 tint = mix(vec3(1.0), hue2rgb(vHue), uSaturation);
  // The glass BODY carries only a wash of colour — a real cat's eye is mostly
  // clear, and the colour lives in the vane suspended in the middle of it. The
  // core is a small denser knot at the centre, not the whole marble: at 0.52 it
  // swallowed the sphere and every marble came out as a solid coloured ball
  // with a rim, which is the plastic look again by another route.
  vec3 transmit = uInterior + tint * uBodyTint;
  transmit = mix(transmit, tint * uCoreGain, core);

  // The vane is a flat disc through the middle in the marble's OWN frame, and
  // it is found the same way: carry the refracted ray into object space and
  // see where it crosses the disc's plane. Being a real disc rather than a
  // band on the normal is what makes it foreshorten to a slot edge-on and
  // open out to a circle face-on — which is what actually reads as spin.
  vec4 conj = vec4(-vSpin.xyz, vSpin.w);
  vec3 pObj = qrot(conj, p);
  vec3 rObj = qrot(conj, rd);
  float denom = abs(rObj.y) < 1e-4 ? 1e-4 : rObj.y;
  float tv = -pObj.y / denom;
  vec3 hit = pObj + rObj * tv;
  float rr = length(hit.xz);
  float vane = tv > 0.0 ? (1.0 - smoothstep(uVaneWidth * 0.72, uVaneWidth, rr)) : 0.0;
  vane *= uVane;
  transmit = mix(transmit, mix(vec3(1.0), hue2rgb(fract(vHue + 0.5)), uVaneTint), vane);

  // ---- what it reflects
  //
  // The same room mercury reflects, for the same reason: a reflection has to
  // stay put while the object moves, or it reads as paint. Anchored to gravity
  // so tipping the box sweeps the horizon across every marble at once.
  vec3 refl = reflect(-view, nrm);
  float tip = clamp(dot(refl.xy, uUp) * uEnvSharp + uPitch, -1.0, 1.0);
  vec3 env = mix(uGround, uSky, smoothstep(-0.6, 0.6, tip));
  float d = tip - uLampAt;
  env += uLampGain * exp(-d * d * uLampWidth);

  vec3 c = mix(transmit, env, fres);

  // One tight highlight, the specular reflection of the lamp itself.
  vec3 half3 = normalize(lightDir + view);
  c += pow(max(dot(nrm, half3), 0.0), uSpecPower) * uSpecular;

  // A marble buried in the pile gets less light, exactly as a grain of sand
  // does — the solver already works this out per body from how covered it is,
  // and ignoring it is what makes a heap look like stickers on a page.
  c *= mix(1.0 - uBurial, 1.0, vLight);

  c = mix(c, uFog, uDepthDim * smoothstep(uFogStart, 1.0, vDepth));

  float a = smoothstep(1.0, 0.965, r2);
  gl_FragColor = vec4(c, a);
}
`;
