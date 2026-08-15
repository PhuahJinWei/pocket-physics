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

uniform vec2 uViewport;
uniform float uFocal;
uniform vec2 uEye;
uniform float uPointSize;
uniform float uDepthRange;

varying float vSpeed;
varying float vFade;

void main() {
  float persp = uFocal / (uFocal + aPos.z);
  vec2 p = uEye + (aPos.xy - uEye) * persp;
  vec2 unit = p / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  gl_PointSize = uPointSize * persp;
  vSpeed = aSpeed;
  // Deeper water contributes a little less, so the body carries a front-to-back
  // gradient instead of reading as one flat slab of colour.
  vFade = 1.0 - 0.35 * clamp(aPos.z / max(uDepthRange, 1.0), 0.0, 1.0);
}
`;

export const WATER_FIELD_FRAGMENT = `
precision mediump float;

varying float vSpeed;
varying float vFade;

uniform float uGain;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  // Squared falloff: smooth enough that overlapping blobs merge without a seam,
  // tight enough that the body keeps an edge instead of fogging outward.
  float w = 1.0 - r2;
  w = w * w;
  float t = w * uGain * vFade;
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
uniform float uFresnel;
uniform float uFoamAmount;
uniform float uFoamBias;
uniform float uAlphaMin;
uniform float uOpacify;
uniform float uCalmRipple;
uniform float uRippleGain;

void main() {
  vec4 c = texture2D(uField, vUV);
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
  float l = texture2D(uField, vUV - vec2(uTexel.x, 0.0)).x;
  float r = texture2D(uField, vUV + vec2(uTexel.x, 0.0)).x;
  float d = texture2D(uField, vUV - vec2(0.0, uTexel.y)).x;
  float u = texture2D(uField, vUV + vec2(0.0, uTexel.y)).x;

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
  float relief = uRelief * max(ripple, edgeBand);
  vec3 nrm = normalize(vec3((l - r) * relief, (d - u) * relief, 1.0));

  // Beer-Lambert: colour is how much water the light had to cross, so thin
  // edges stay pale and the body deepens toward the middle. This single term
  // does most of the work of making it read as a volume rather than a shape.
  float travel = 1.0 - exp(-uAbsorb * t);
  vec3 color = mix(uShallow, uDeep, travel);

  // +y is up the screen in this pass, unlike gl_PointCoord in the grain
  // shader where it points down. Getting that backwards lights the water from
  // underneath and puts a bright rim along the floor instead of the surface.
  vec3 lightDir = normalize(vec3(-0.35, 0.62, 0.70));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 half3 = normalize(lightDir + view);
  float spec = pow(max(dot(nrm, half3), 0.0), 60.0) * uSpecular;
  // Grazing angles reflect more than head-on ones; on a body this shallow the
  // rim is the only place that happens, and it is what stops the edge looking
  // like cut paper.
  float fresnel = pow(1.0 - clamp(nrm.z, 0.0, 1.0), 3.0) * uFresnel;

  color += spec + fresnel;

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
