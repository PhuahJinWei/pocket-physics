// GLSL ES 1.00 so one shader pair works on both WebGL1 and WebGL2 contexts.
//
// Each grain is a single point sprite. The fragment shader reconstructs a fake
// sphere normal from gl_PointCoord and lights it, which is what turns flat
// points into beads. Two passes share the program: mode 0 draws a wide dim
// additive halo, mode 1 draws the alpha-blended bead on top.

export const VERTEX_SHADER = `
precision highp float;

attribute vec2 aPos;      // sim position, CSS px
attribute vec2 aShade;    // x: surface light 0..1, y: normalised speed 0..1
attribute vec2 aJitter;   // x: size variation, y: tint variation

uniform vec2 uViewport;   // CSS px
uniform float uPointSize; // device px, already scaled by dpr
uniform float uSpeedBoost;

varying float vLight;
varying float vSpeed;
varying float vTint;

void main() {
  vec2 unit = aPos / uViewport;
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
  float grow = 1.0 + aShade.y * uSpeedBoost;
  gl_PointSize = uPointSize * (0.88 + 0.24 * aJitter.x) * grow;
  vLight = aShade.x;
  vSpeed = aShade.y;
  vTint = aJitter.y;
}
`;

export const FRAGMENT_SHADER = `
precision highp float;

varying float vLight;
varying float vSpeed;
varying float vTint;

uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uIce;
uniform float uMode;      // 0.0 = glow pass, 1.0 = bead pass
uniform float uGlow;

vec3 grainColor() {
  float t = clamp(vLight, 0.0, 1.0);
  vec3 c = mix(uDeep, uMid, smoothstep(0.0, 0.55, t));
  c = mix(c, uIce, smoothstep(0.45, 1.0, t));
  c = mix(c, vec3(1.0), clamp(vSpeed, 0.0, 1.0) * 0.7);
  return c * (0.72 + 0.28 * vTint);
}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  vec3 base = grainColor();

  if (uMode < 0.5) {
    // Soft halo. Premultiplied and additively blended, so bright clusters
    // bloom into each other the way the LCD does on camera.
    float falloff = exp(-r2 * 3.4) - 0.033;
    float amount = uGlow * max(falloff, 0.0) * (0.35 + 0.65 * clamp(vLight, 0.0, 1.0));
    gl_FragColor = vec4(base * amount, amount);
    return;
  }

  // Bead: hemisphere normal from the sprite coordinate.
  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = vec3(uv.x, uv.y, z);
  vec3 lightDir = normalize(vec3(-0.42, -0.6, 0.68));
  float diffuse = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - z, 2.5);
  vec3 half3 = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, half3), 0.0), 26.0);

  vec3 color = base * (0.34 + 0.82 * diffuse);
  // Keep the highlight off buried grains, or the bulk turns grey and muddy.
  color += vec3(0.72, 0.86, 1.0) * spec * (0.08 + 0.92 * clamp(vLight, 0.0, 1.0));
  color *= 1.0 - 0.28 * rim;

  float alpha = smoothstep(1.0, 0.82, r2);
  gl_FragColor = vec4(color, alpha);
}
`;
