// Water is drawn in two passes, because drawing the particles directly cannot
// work: a liquid has no visible particles, only a surface. Sprites blended one
// on top of another read as a heap of blue beads no matter how they are shaded.
//
// Pass one throws every particle into an offscreen buffer as a soft blob, added
// together, which gives a smooth scalar field — how much water is in front of
// each pixel. Pass two never sees a particle at all: it reads that field, takes
// its level set as the surface, its gradient as a normal, and its magnitude as
// the distance light had to travel through water. That is where the colour,
// the highlights and the edges come from.
//
// The field is deliberately a plain RGBA8 texture at half resolution. Half res
// is not only cheaper, it is a free blur — it smooths the blobs into a surface,
// which is exactly the step a full screen-space fluid renderer spends a
// separate bilateral filter on.

export const WATER_FIELD_VERTEX = `
precision highp float;

attribute vec3 aPos;
attribute float aSpeed;
// +1 for a real particle, -1 for a wall image. Only the sign carries meaning;
// the fragment shader clips images to the box and leaves real particles alone.
attribute float aWeight;

// The field is drawn into a frame slightly larger than the screen: uViewport
// is that padded size and uOrigin is where the screen's own (0,0) sits inside
// it. See Renderer.ensureField for why the padding has to exist.
uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform float uFocal;
uniform vec2 uEye;
uniform float uPointSize;
uniform float uDepthRange;
uniform vec2 uBox;        // sim px: box width and height
uniform vec2 uFieldSize;  // the offscreen buffer, in its own pixels
uniform float uRadius;    // particle radius, sim px

varying float vSpeed;
varying float vFade;
varying float vWeight;
varying float vIsImage;
// The box's outline on the field at this particle's NEAR face and FAR face:
// xmin, xmax, ymin, ymax in field pixels. See the fragment shader.
varying vec4 vNear;
varying vec4 vFar;

vec4 outlineAt(float z) {
  float persp = uFocal / (uFocal + z);
  vec2 lo = uEye * (1.0 - persp) + uOrigin;
  vec2 hi = uEye + (uBox - uEye) * persp + uOrigin;
  vec2 sc = uFieldSize / uViewport;
  // The field buffer's y runs up from the bottom, unlike css.
  return vec4(lo.x * sc.x, hi.x * sc.x, (uViewport.y - hi.y) * sc.y, (uViewport.y - lo.y) * sc.y);
}

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 p = uEye + (aPos.xy - uEye) * persp + uOrigin;
  vec2 unit = p / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  gl_PointSize = uPointSize * persp;
  vSpeed = aSpeed;
  vWeight = abs(aWeight);
  vIsImage = step(aWeight, 0.0);
  // Deeper water contributes a little less, so the body carries a front-to-back
  // gradient instead of reading as one flat slab of colour.
  vFade = 1.0 - 0.35 * clamp(aPos.z / max(uDepthRange, 1.0), 0.0, 1.0);

  // A particle is a ball uRadius deep, not a plane. The box's outline slides
  // inward on screen between the ball's near face and its far face, and how
  // far across that slide a pixel sits is how much of the ball its ray reaches.
  vNear = outlineAt(max(aPos.z - uRadius, 0.0));
  vFar = outlineAt(min(aPos.z + uRadius, uDepthRange));
}
`;

export const WATER_FIELD_FRAGMENT = `
// The ray math below divides by a drift that passes through zero down the
// middle of the screen; mediump loses the far walls, so take highp where the
// hardware has it.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying float vSpeed;
varying float vFade;
varying float vWeight;
varying float vIsImage;
varying vec4 vNear;
varying vec4 vFar;

uniform float uGain;
// The same frame the vertex shader drew into: padded css size, where the
// screen's (0,0) sits in it, and the buffer's size in its own pixels.
uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform vec2 uFieldSize;
uniform vec2 uEye;
uniform float uFocal;
uniform vec2 uBox;
uniform float uDepthRange;
uniform float uRadius;
uniform float uRayFloor;
uniform float uClipReal;   // 1: real particles are clipped to the box like images

// Depth-fade integrals, so a ray's capacity is weighted exactly as the field
// weights the balls it sums: P is the integral of vFade, Q of z * vFade.
float fadeP(float z) { return z - 0.175 * z * z / uDepthRange; }
float fadeQ(float z) { return 0.5 * z * z - 0.35 * z * z * z / (3.0 * uDepthRange); }

// How much liquid the ray through this pixel could hold, as a fraction of a
// ray that runs the whole depth, in the units the sum below is taken in.
//
// The field is a screen-space count of what lies along a view ray, but the
// box is a 3-D volume in perspective and its walls converge going back. A ray
// aimed near a wall leaves through that wall almost at once and crosses only
// a sliver of the box; one up the middle runs the full depth. So the field
// falls away toward every wall even when the box is brim full, and one
// absolute threshold reads that as "less liquid here": the silhouette shrinks
// back from the glass, and frays into grey haze along the floor. Divided by
// its own capacity, a full sliver is as full as a full column and the liquid
// meets the glass.
//
// Capacity is not the ray's plain length. What the sum actually counts is
// balls, each reached by the ray in proportion to how far past its near face
// the ray gets (that ramp is the "inside" factor below), weighted by depth
// fade. So the capacity is that same ramp integrated over every ball a full
// box would hold — which is what makes a full box come out at exactly 1.0
// right up to the corner, and is why the corner does not starve: the first
// ball a corner ray reaches is a small fraction of a small capacity, not of a
// large one.
//
// The balls are integrated over centres from 0 to depth, not from uRadius to
// depth - uRadius, even though no centre can actually sit closer to the glass
// than uRadius. The liquid is a lattice: its first row sits AT uRadius and
// owns the whole slab from 0 to 2 * uRadius, so in the continuum limit the
// centre density runs edge to edge. Integrating from uRadius instead credited
// a corner ray with a quarter of the balls it really reaches — measured, the
// last 10px at every wall came out over-boosted into saturation.
//
// At the front glass screen space and sim space coincide, so the pixel IS the
// ray's entry point, drifting by (p - eye) / focal per unit of depth.
float capacityAt(vec2 pcss) {
  vec2 drift = (pcss - uEye) / uFocal;
  float zExit = uDepthRange;
  if (drift.x < -1e-6) zExit = min(zExit, -pcss.x / drift.x);
  else if (drift.x > 1e-6) zExit = min(zExit, (uBox.x - pcss.x) / drift.x);
  if (drift.y < -1e-6) zExit = min(zExit, -pcss.y / drift.y);
  else if (drift.y > 1e-6) zExit = min(zExit, (uBox.y - pcss.y) / drift.y);
  zExit = clamp(zExit, 0.0, uDepthRange);

  float r = uRadius;
  float a = 0.0;                  // centre density runs from the front glass
  float b = uDepthRange;          // to the back
  // Balls the ray passes completely: centres up to zExit - r.
  float z0 = a;
  float z1 = clamp(zExit - r, a, b);
  float full = fadeP(z1) - fadeP(z0);
  // Balls the ray only reaches part way into: centres zExit - r .. zExit + r,
  // each counting (zExit + r - z) / 2r of itself.
  float z2 = clamp(zExit - r, a, b);
  float z3 = clamp(zExit + r, a, b);
  float part = ((zExit + r) * (fadeP(z3) - fadeP(z2)) - (fadeQ(z3) - fadeQ(z2))) / (2.0 * r);
  float whole = fadeP(b) - fadeP(a);
  // A ray that only clips a corner reaches next to nothing, and dividing by
  // next to nothing turns a stray blob tail into liquid. Floor it.
  return max((full + part) / max(whole, 1e-3), uRayFloor);
}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // Clip IMAGES to the box as it stands at their own depth: nothing before the
  // outline at the ball's near face, all of it past the outline at its far
  // face, a linear ramp between.
  //
  // This is what makes the wall images in Renderer.packWater safe. An image is
  // a real blob drawn beyond the glass, and unclipped it spills onto pixels
  // whose rays left the box long before reaching its layer: measured, that
  // piled a lip along the top of the liquid at each wall and, with the liquid
  // sitting at the back, dropped floor images into plain view as detached grey
  // blobs — six lit regions, five of them with no particle in them at all.
  //
  // Whether REAL particles are clipped too is a switch (uClipReal, from
  // CONFIG.render.clipReal), because it is a trade and not a bug either way.
  //
  // Unclipped, a real blob spills across the outline of its own layer into
  // the strip where the ray has already left the box. That spill is what the
  // capacity divide then amplifies: measured on water at 75 degrees, the field
  // reads 2.35x bulk 2px from a side wall and is not back within 5% until
  // 24px, which shades as a band along every wall; and with the liquid lying
  // on the back wall the same spill paints a 55% film of liquid over the dry
  // side wall, ending in a visible step where the images take over. Neither
  // the images nor the capacity floor touch it — measured, images change the
  // first 12px by exactly zero, and rayFloor moves only the last column.
  //
  // Clipped, the strip reads bulk (0.94-1.02 from 4px in) and the film is
  // gone: the pool ends where the wall is. But it also restores the true
  // perspective of the free surface, which the spill was hiding: the
  // waterline on the side glass runs from the front-top corner to the
  // back-top corner, and screen-up the pool leans back as well, so measured
  // the silhouette drops 40px at the wall at 75 degrees and 16px upright.
  // Unclipped it is flat within 4px, which is the look that was asked for.
  vec2 fc = gl_FragCoord.xy;
  float box =
      clamp((fc.x - vNear.x) / max(vFar.x - vNear.x, 0.5), 0.0, 1.0)
    * clamp((vNear.y - fc.x) / max(vNear.y - vFar.y, 0.5), 0.0, 1.0)
    * clamp((fc.y - vNear.z) / max(vFar.z - vNear.z, 0.5), 0.0, 1.0)
    * clamp((vNear.w - fc.y) / max(vNear.w - vFar.w, 0.5), 0.0, 1.0);
  float inside = mix(mix(1.0, box, uClipReal), box, vIsImage);
  if (inside <= 0.0) discard;

  // Squared falloff: smooth enough that overlapping blobs merge without a seam,
  // tight enough that the body keeps an edge instead of fogging outward.
  float w = 1.0 - r2;
  w = w * w;
  // Divided by capacity HERE, per fragment, not in the composite. The sum is
  // linear so it comes to the same thing — except that the field is 8-bit,
  // and a corner ray's raw thickness is one or two quantisation levels that no
  // later division can recover. Stored already normalised, it is a full-scale
  // value like anywhere else.
  vec2 pcss = fc * (uViewport / uFieldSize);
  pcss = vec2(pcss.x, uViewport.y - pcss.y) - uOrigin;
  float t = w * uGain * vFade * vWeight * inside / capacityAt(pcss);
  // R: thickness. G: thickness weighted by speed, so the composite can divide
  // the two back out and know how agitated the water at this pixel is.
  gl_FragColor = vec4(t, t * vSpeed, 0.0, 1.0);
}
`;

export const WATER_COMPOSITE_VERTEX = `
precision highp float;
attribute vec2 aCorner;
varying vec2 vUV;
void main() {
  vUV = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}
`;

export const WATER_COMPOSITE_FRAGMENT = `
precision mediump float;

varying vec2 vUV;

uniform sampler2D uField;
uniform vec2 uTexel;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoamColor;
uniform float uSurface;
uniform float uSoft;
uniform float uAbsorb;
uniform float uRelief;
uniform float uSpecular;
uniform float uSpecPower;
uniform float uFresnel;
uniform float uMetal;      // 0 = transparent liquid, 1 = mirror
uniform float uFoamAmount;
uniform float uFoamBias;
uniform float uAlphaMin;
uniform float uOpacify;
uniform float uCalmRipple;
uniform float uRippleGain;
// The reflected room, for uMetal surfaces. uUp is world up in screen space, so
// the horizon is anchored to gravity rather than to the screen.
uniform vec2 uUp;
uniform float uPitch;
uniform float uEnvSharp;
uniform float uHorizon;
uniform float uLampAt;
uniform float uLampWidth;
uniform float uLampGain;

// The field is padded around the screen (see Renderer.ensureField): where the
// screen's (0,0) sits inside it, and its full css extent — both in css px, and
// against the screen's own css size.
uniform highp vec2 uViewport;
uniform highp vec2 uFieldOrigin;
uniform highp vec2 uFieldSpan;

// The box, and the width of the strip along each wall whose gradient cannot be
// believed. In highp: these are screen-scale numbers divided by small ones.
uniform highp vec2 uBox;
uniform highp vec2 uGuard;

// Distance from the nearest wall on each axis, in units of uGuard — the width
// of the strip along each wall whose gradient cannot be believed. 0 at a wall,
// 1 at the edge of the strip, and it keeps counting past it, which is the
// point: a measure that saturates at the edge cannot express "well clear of the
// wall", and these artefacts run past it.
//
// Per axis, not a single distance, because they have a direction: both vary
// with distance FROM a wall, so next to the floor it is the VERTICAL gradient
// that is untrustworthy and next to a side wall the horizontal one. Killing
// both is what turned the bright line into a dark band.
//
// uGuard covers two different things that happen to live in the same place, and
// it is the LARGER of the two (see Renderer.drawFluid):
//   - the band where the box converges away behind the glass, so the capacity
//     correction is large and inexact;
//   - the first row of particles, which sits one radius off every wall and, on
//     a flat floor, is a dead straight line of blobs the full width of the box.
// Sizing the guard on perspective alone hid the second one only by luck: in a
// tall window the band is 25px and swallows it, in a wide one the band is 10px
// and the lattice row at ~12px sits just outside, lit as a bright seam.
highp vec2 wallDistance(highp vec2 p) {
  return min(p, uBox - p) / max(uGuard, vec2(1.0));
}

// Field texture coordinate for a css screen position: shift into the padded
// frame, then flip, since the texture's v runs up from the bottom.
highp vec2 fieldUV(highp vec2 pcss) {
  highp vec2 q = (pcss + uFieldOrigin) / uFieldSpan;
  return vec2(q.x, 1.0 - q.y);
}

void main() {
  highp vec2 pcss = vec2(vUV.x, 1.0 - vUV.y) * uViewport;
  vec4 c = texture2D(uField, fieldUV(pcss));
  // Thickness as a fraction of what this pixel's ray could hold — the field
  // pass has already divided out the box's perspective (see capacityAt there),
  // so a full box reads as full right up to the glass.
  float t = c.x;
  // The level set of the thickness field is the water's silhouette. Everything
  // below the threshold is air, and the soft band across it is the anti-aliased
  // edge — a hard cutoff crawls with visible stair-steps as the body moves.
  float mask = smoothstep(uSurface, uSurface + uSoft, t);
  if (mask <= 0.004) discard;

  float agitation = c.y / max(c.x, 1e-4);

  // Normal from the gradient of thickness. At the waterline thickness ramps up
  // from nothing, so the normal tips over and catches the light there — which
  // is exactly where a real surface shows its edge.
  highp vec2 stepCss = uTexel * uFieldSpan;   // one field texel, in css px
  float l = texture2D(uField, fieldUV(pcss - vec2(stepCss.x, 0.0))).x;
  float r = texture2D(uField, fieldUV(pcss + vec2(stepCss.x, 0.0))).x;
  // css y runs down the screen.
  float d = texture2D(uField, fieldUV(pcss + vec2(0.0, stepCss.y))).x;
  float u = texture2D(uField, fieldUV(pcss - vec2(0.0, stepCss.y))).x;

  // Calm water is glass. The particle lattice leaves a permanent fine ripple
  // in the thickness field, and at full strength the normal shades it like
  // wrinkled plastic — so agitation (speed, carried per-pixel in G) decides
  // how much of the gradient the interior normal is allowed to see.
  //
  // The silhouette band is exempt. Measured, its gradients are the *same
  // size* as the lattice noise (both p90 = 0.07/texel in the half-res field),
  // so no magnitude test can tell them apart — but they live at opposite ends
  // of the thickness ramp. Thin pixels are the waterline and the rim; keeping
  // them at full relief is what preserves the specular band along the surface
  // of a resting body, which gating by agitation alone wiped out.
  float edgeBand = 1.0 - smoothstep(uSurface * 1.6, uSurface * 4.5, t);
  float ripple = clamp(uCalmRipple + agitation * uRippleGain, 0.0, 1.0);

  // Do not shade the corrected band. Where a ray leaves the box early the field
  // pass divided its thickness by a small, and only approximate, capacity, and
  // what the approximation leaves behind is a ramp in the field that no liquid
  // put there — measured on water, 2.5x the bulk value hard against the floor,
  // still 1.6x a third of the way in, back within 5% only past ~24px. Relief
  // reads that ramp as a steeply tilted surface and lights it: that is the
  // bright line along the floor and up both walls.
  //
  // The ramp cannot be tuned away. It is worst where the wedge is thinner than
  // one particle row, and there no continuum estimate of capacity is accurate —
  // raising uRayFloor only trades the line back for a sloping surface. So gate
  // the shading instead: the band is a correction, not a shape, and it is
  // trusted for coverage but not for a normal.
  //
  // The gate has to open LATE, outside the band, and PER AXIS. Two earlier
  // versions keyed on the fraction of the box the ray crosses, which saturates
  // at the band edge; both merely moved the line to wherever the gate sat
  // half-open (11px above the floor, then 17px). Measured against the band
  // width instead, the field is back within 5% of bulk about two band-widths
  // out, so that is where the suspect component is restored.
  //
  // Per axis is what keeps the cure from being as visible as the disease.
  // Damping BOTH components near a wall leaves the margin with a normal facing
  // straight at the viewer: no fresnel, no glint, so it read as a dark band
  // against a body full of ripple — trading a bright line for a dark one. Only
  // the component running across the wall carries the artefact. Next to the
  // floor the horizontal gradient is still honest surface, and keeping it is
  // what lets the margin shade like the water it is part of.
  vec2 trust = smoothstep(vec2(0.4), vec2(2.0), wallDistance(pcss));
  float relief = uRelief * max(ripple, edgeBand);
  vec3 nrm = normalize(vec3((l - r) * relief * trust.x,
                            (d - u) * relief * trust.y, 1.0));

  // Beer-Lambert: colour is how much water the light had to cross, so thin
  // edges stay pale and the body deepens toward the middle. This single term
  // does most of the work of making it read as a volume rather than a shape.
  float travel = 1.0 - exp(-uAbsorb * t);
  vec3 color = mix(uShallow, uDeep, travel);

  // +y is up the screen in this pass, unlike gl_PointCoord in the grain
  // shader where it points down. Getting that backwards lights the water from
  // underneath and puts a bright rim along the floor instead of the surface.
  vec3 lightDir = normalize(vec3(-0.35, 0.62, 0.70));

  // A metal has no Beer-Lambert term — nothing gets in, so thickness means
  // nothing and the colour is entirely what the surface reflects. What it
  // reflects is a room, and the whole character of a mirror is that the room
  // STAYS PUT while the object moves: tip the box and the horizon sweeps
  // across the mercury. That sweep is most of what separates mercury from grey
  // paint, and the old version could not do it — it keyed on nrm.y, which is
  // fixed to the screen, so the shading was identical however the phone was
  // held. uUp is world up in screen space, straight off the gravity vector.
  if (uMetal > 0.0) {
    // How far this bit of surface tips toward the sky. Two terms, and the
    // second is the one that matters:
    //
    //   uUp   turns the horizon with the box, so a sloped bit of surface — the
    //         rim, a ripple, a wave — reflects sky or ground depending on which
    //         way it leans in the ROOM rather than on the screen.
    //   uPitch slides the whole reflection. This is the term that makes a flat
    //         pool respond at all: its normals are all (0,0,1), and a mirror
    //         facing the viewer reflects the same patch of room however you
    //         spin it about the view axis, so uUp alone left the body a fixed
    //         tone at every tilt (measured: mean 196.5 upright vs 195.1 at 45
    //         degrees, which is nothing). Tipping the phone face-up aims that
    //         mirror at the ceiling and face-down at the floor, and THAT is
    //         what a hand actually does.
    float tip = clamp(dot(nrm.xy, uUp) * uEnvSharp + uPitch, -1.0, 1.0);
    // Ground below the horizon, sky above it. Sharp, because a mirror's
    // horizon is a line, not a gradient — that hard edge sliding over the
    // surface is what the eye reads as "reflective".
    vec3 env = mix(uDeep, uShallow, smoothstep(-uHorizon, uHorizon, tip));
    // And the light itself, reflected: a narrow band just off the horizon.
    // Physically it is the window in the room; visually it is the thing that
    // rakes across the metal as you tilt.
    float d = tip - uLampAt;
    env += uLampGain * exp(-d * d * uLampWidth);
    color = mix(color, env, uMetal);
    // Turn the key light with the room too, so the glint below travels with
    // the horizon instead of staying pinned to one corner of the screen.
    // Rotating (0,1) onto uUp is the matrix [[uy, ux], [-ux, uy]].
    vec2 rl = vec2(uUp.y * lightDir.x + uUp.x * lightDir.y,
                  -uUp.x * lightDir.x + uUp.y * lightDir.y);
    lightDir = normalize(vec3(mix(lightDir.xy, rl, uMetal), lightDir.z));
  }

  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 half3 = normalize(lightDir + view);
  // Highlight tightness is a material property, not a constant. Water is a
  // rippled mirror and scatters a lot of small hard glints; a thick syrup is a
  // smooth one and carries a single broad sheen instead. Sharing one exponent
  // is a good part of why two liquids read as the same liquid recoloured.
  float spec = pow(max(dot(nrm, half3), 0.0), uSpecPower) * uSpecular;
  // Grazing angles reflect more than head-on ones; on a body this shallow the
  // rim is the only place that happens, and it is what stops the edge looking
  // like cut paper.
  float fresnel = pow(1.0 - clamp(nrm.z, 0.0, 1.0), 3.0) * uFresnel;

  // Roll the glint off instead of letting it clip. Added raw, a strong
  // highlight (mercury reaches ~2.0) saturates every pixel it touches to the
  // same flat 255, so the rim stops being a gradient and becomes a solid white
  // slab of uniform colour. A slab of white tracing the silhouette reads as a
  // drawn outline rather than a reflection, and where the silhouette rounds a
  // corner that outline hooks back on itself and looks like a claw. Measured on
  // resting mercury: a 16px band along the shoulder was pure 255 with no
  // gradient across it at all.
  //
  // The compression is deliberately parameter-free: x/(1+x) leaves small values
  // almost untouched, so water and honey (whose glints are well under 1) shade
  // as before, and only the highlights that would have clipped are pulled back.
  // The peak still reaches white once the base colour is added -- it just gets
  // there at a point instead of across a band, which is what makes it read as
  // light falling on a curved surface.
  float glint = spec + fresnel;
  color += glint / (1.0 + glint);

  // Foam where the water is both moving and thin — the crest of a wave and the
  // spray off a splash, not the calm mass underneath it.
  float foam = clamp((agitation - uFoamBias) * uFoamAmount, 0.0, 1.0)
    * smoothstep(1.0, 0.35, t);
  color = mix(color, uFoamColor, foam);

  // Water is transparent; gel is not. Coverage follows thickness by the same
  // Beer-Lambert law as the colour: a thin crest lets the box show through,
  // the deep body blocks it. Glints and foam stay opaque regardless — a
  // reflection does not care what is behind the surface.
  float body = 1.0 - exp(-uOpacify * t);
  float alpha = mask * mix(uAlphaMin, 1.0, body);
  alpha = clamp(alpha + spec + foam * 0.6, 0.0, 1.0);

  gl_FragColor = vec4(color, alpha);
}
`;
