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
uniform float uLooseShrink;
uniform float uGain;      // peak of a packed grain's blob
uniform float uBlob;      // blob radius as a multiple of the grain radius
uniform float uThreshold; // worst-case coverage the composite calls "sand"
uniform float uSoloSize;  // where a lone grain's level set lands, in radii
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

  // Two regimes, blended by whether the grain has anything to overlap with.
  //
  // A grain in the mass contributes a moderate blob and the surface is built
  // out of hundreds of them summing together, so its own peak hardly matters.
  // ('packed' is a reserved word in GLSL ES — hence 'bulk'.) Depth barely
  // touches it: sand is opaque however deep it sits, and attenuating the back
  // of the box drew the sand that is only there — the band you see above the
  // front surface when the bed leans on the back wall — as a thin, translucent
  // smear that tore into holes. Measured, that band ramped from 6 to 46 in a
  // field whose threshold is 22. What SHOULD change with depth is colour, and
  // that is the composite's job (uDepthDim there); the small weight kept here
  // only lets the front layer lead the averages a little.
  //
  // A grain touching NOTHING has to clear the threshold by itself or it is not
  // drawn at all, and with a fixed peak it usually could not: measured, 75% of
  // the grains in a splash rendered as literally nothing. So it gets exactly
  // the peak that lands its level set on uSoloSize of its own radius. Solving
  // for the peak rather than turning the gain up is what keeps this safe: a
  // narrow blob with a tall peak is a compact dot that cannot bridge to
  // anything, and because uSoloSize sits inside the blob radius the peak
  // needed stays low enough that several may overlap before the 8-bit field
  // clips (measured max 186/255 through a splash, nothing clipped).
  //
  // Gated on *airborne*, not on looseness. A surface grain is under-coordinated
  // by definition — four contacts instead of six — and blending it toward the
  // solo peak bulges it out of the surface as its own lump, which fringes the
  // whole bed with grain-sized nubs: exactly the scale the field render exists
  // to hide.
  //
  // A lone grain also gets a gentler blob profile (uAirPow, against 2 for the
  // mass), so the coverage ramps across its edge over more pixels and the
  // composite's fixed soft band lands as a soft, porous puff instead of a
  // hard-rimmed pea. The peak has to be solved against that same profile.
  float bulk = uGain * (1.0 - uDepthWeight * depth);
  float rn = min(uSoloSize / (uBlob * shrink), 0.95);
  float e = 1.0 - rn * rn;
  float prof = mix(e * e, pow(e, uAirPow), air);
  float solo = uThreshold / max(prof, 1e-3);
  vWeight = mix(bulk, max(bulk, solo), air);
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
