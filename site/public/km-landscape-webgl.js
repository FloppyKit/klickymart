/**
 * WebGL synthwave highway — lazy-loaded after first paint.
 * Fidelity 0–3 from agent reach (or ?tier=); sun from BTC score.
 */
import * as THREE from "/vendor/three.module.min.js";

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uBot;
uniform float uFidelity;
varying vec3 vWorld;
void main() {
  float h = normalize(vWorld).y * 0.5 + 0.5;
  vec3 col = mix(uBot, uMid, smoothstep(0.0, 0.55, h));
  col = mix(col, uTop, smoothstep(0.45, 1.0, h));
  float stars = step(2.1, uFidelity) * step(0.92, h) * fract(sin(dot(vWorld.xz, vec2(12.9898,78.233))) * 43758.5453);
  col += vec3(stars * 0.35);
  gl_FragColor = vec4(col, 1.0);
}`;

const ROAD_VERT = /* glsl */ `
varying vec2 vUv;
varying float vDist;
void main() {
  vUv = uv;
  vDist = -position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ROAD_FRAG = /* glsl */ `
uniform float uScroll;
uniform float uFidelity;
uniform float uBtc;
uniform vec3 uGrid;
uniform vec3 uMid;
uniform vec3 uSunDir;
uniform float uLight;
varying vec2 vUv;
varying float vDist;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

void main() {
  float z = vDist + uScroll;
  float depth = clamp(z / 120.0, 0.0, 1.0);
  float center = abs(vUv.x - 0.5);
  float onRoad = 1.0 - smoothstep(0.22, 0.28, center);

  float wire = 1.0 - smoothstep(0.0, 0.35, uFidelity);
  float flat = smoothstep(0.2, 0.9, uFidelity) * (1.0 - smoothstep(1.8, 2.4, uFidelity));
  float ps2 = smoothstep(1.4, 2.2, uFidelity) * (1.0 - smoothstep(2.6, 3.0, uFidelity));
  float sw = smoothstep(2.3, 2.95, uFidelity);

  vec3 base = vec3(0.02, 0.06, 0.05);
  base = mix(base, vec3(0.05, 0.08, 0.07), flat + ps2 + sw);
  base = mix(base, uGrid * 0.08, onRoad * (flat + ps2 + sw));

  float gridX = abs(fract(vUv.x * 24.0) - 0.5);
  float gridZ = abs(fract(z * 0.35) - 0.5);
  float lineX = smoothstep(0.48, 0.5, gridX) * step(0.28, center);
  float lineZ = smoothstep(0.46, 0.5, gridZ);
  float grid = max(lineX, lineZ) * (wire + flat * 0.6);

  float lane = step(0.02, center) * step(center, 0.06);
  float dash = step(0.5, fract(z * 0.8));
  float centerLine = lane * dash * onRoad;

  float noise = hash(vUv * 40.0 + z * 0.1) * ps2 * 0.15;
  base += uGrid * grid * (0.35 + wire * 0.65);
  base += vec3(1.0, 0.85, 0.35) * centerLine * (0.5 + flat);
  base += noise;

  float sheen = pow(max(0.0, 1.0 - abs(dot(normalize(vec3(0.0, 1.0, 0.3)), uSunDir))), 8.0);
  base += uGrid * sheen * onRoad * (ps2 * 0.25 + sw * 0.55);

  float wet = pow(max(0.0, 1.0 - length(vUv - vec2(0.5, fract(uScroll * 0.02 + uBtc * 0.1)))), 3.0);
  base += vec3(1.0, 0.6, 0.2) * wet * onRoad * sw * uBtc * 0.8;

  float fog = depth * depth * (0.15 + ps2 * 0.35 + sw * 0.25);
  base = mix(base, uMid * 0.3, fog);

  gl_FragColor = vec4(base, 1.0);
}`;

const MOUNT_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vWorld;
void main() {
  vPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const MOUNT_FRAG = /* glsl */ `
uniform float uFidelity;
uniform vec3 uGrid;
uniform vec3 uMid;
varying vec3 vPos;
varying vec3 vWorld;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

void main() {
  float wire = 1.0 - smoothstep(0.0, 0.45, uFidelity);
  float flat = smoothstep(0.35, 1.0, uFidelity) * (1.0 - smoothstep(1.9, 2.5, uFidelity));
  float ps2 = smoothstep(1.5, 2.3, uFidelity);
  float sw = smoothstep(2.4, 3.0, uFidelity);

  float h = clamp(vPos.y / 8.0, 0.0, 1.0);
  float n = hash(vWorld.xz * 0.15) * ps2 + hash(vWorld.xz * 0.4) * sw * 0.5;
  vec3 fill = mix(vec3(0.08, 0.02, 0.14), uGrid * 0.25, flat);
  fill = mix(fill, vec3(0.12, 0.1, 0.14), ps2 * h);
  fill = mix(fill, vec3(0.18, 0.16, 0.22), sw * h);
  fill += n * 0.08;

  float edge = smoothstep(0.85, 1.0, h);
  vec3 col = mix(fill, uGrid * 0.9, edge * wire);
  float fog = smoothstep(5.0, 80.0, -vWorld.z);
  col = mix(col, uMid * 0.25, fog * (0.3 + ps2 * 0.5));

  gl_FragColor = vec4(col, flat + ps2 + sw + wire * 0.5);
}`;

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function hexToVec3(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return new THREE.Color((n >> 16) & 255, (n >> 8) & 255, n & 255).multiplyScalar(1 / 255);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function fidelityFromReach(reach, tierOverride) {
  if (tierOverride != null && !Number.isNaN(tierOverride)) {
    return Math.max(0, Math.min(3, tierOverride));
  }
  return clamp01(reach) * 3;
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.glCanvas
 * @param {HTMLCanvasElement} opts.fallbackCanvas
 * @param {number} opts.reach
 * @param {number} opts.btc
 * @param {number|null} opts.tierOverride
 * @param {boolean} opts.reducedMotion
 * @param {() => boolean} opts.isLightTheme
 */
export function mountLandscapeWebGL(opts) {
  const glCanvas = opts.glCanvas;
  const fallback = opts.fallbackCanvas;
  let reach = clamp01(opts.reach);
  let btc = clamp01(opts.btc);
  let tierOverride = opts.tierOverride;
  const reduced = opts.reducedMotion;
  const isLight = opts.isLightTheme;

  const params = new URLSearchParams(window.location.search);
  if (params.has("reach")) {
    const r = parseFloat(params.get("reach") || "");
    if (!Number.isNaN(r)) reach = clamp01(r);
  }
  if (params.has("btc")) {
    const b = parseFloat(params.get("btc") || "");
    if (!Number.isNaN(b)) btc = clamp01(b);
  }
  if (params.has("tier")) {
    const t = parseInt(params.get("tier") || "", 10);
    if (!Number.isNaN(t) && t >= 0 && t <= 3) tierOverride = t;
  }

  const mobile = window.matchMedia("(max-width: 640px)").matches;
  const maxFps = mobile ? 30 : 45;
  const maxDpr = mobile ? 1.25 : 2;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: true,
      alpha: false,
      powerPreference: "low-power",
    });
  } catch {
    return { ok: false };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 250);
  camera.position.set(0, 1.35, 2.2);
  camera.lookAt(0, 0.8, -40);

  const skyGeo = new THREE.SphereGeometry(120, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uBot: { value: new THREE.Color() },
      uFidelity: { value: 0 },
    },
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  const roadGeo = new THREE.PlaneGeometry(40, 140, 1, 40);
  roadGeo.rotateX(-Math.PI / 2);
  roadGeo.translate(0, 0, -60);
  const gridColor = hexToVec3(css("--km-landscape-grid", "#3df29a"));
  const roadMat = new THREE.ShaderMaterial({
    vertexShader: ROAD_VERT,
    fragmentShader: ROAD_FRAG,
    uniforms: {
      uScroll: { value: 0 },
      uFidelity: { value: 0 },
      uBtc: { value: btc },
      uGrid: { value: gridColor },
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
      uLight: { value: 1 },
      uMid: { value: new THREE.Color() },
    },
  });
  const road = new THREE.Mesh(roadGeo, roadMat);
  scene.add(road);

  const mountMat = new THREE.ShaderMaterial({
    vertexShader: MOUNT_VERT,
    fragmentShader: MOUNT_FRAG,
    transparent: true,
    uniforms: {
      uFidelity: { value: 0 },
      uGrid: { value: gridColor },
      uMid: { value: new THREE.Color() },
    },
  });

  const mountains = new THREE.Group();
  const peaks = [
    [-18, 0, -35, 7],
    [-12, 0, -55, 10],
    [14, 0, -42, 8],
    [20, 0, -68, 12],
    [-22, 0, -80, 9],
    [8, 0, -95, 11],
  ];
  peaks.forEach(([x, y, z, h]) => {
    const geo = new THREE.ConeGeometry(6 + h * 0.2, h, 4, 1);
    const mesh = new THREE.Mesh(geo, mountMat);
    mesh.position.set(x, h * 0.5, z);
    mountains.add(mesh);
    if (true) {
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: 0.35 }),
      );
      wire.position.copy(mesh.position);
      wire.userData.wire = true;
      mountains.add(wire);
    }
  });
  scene.add(mountains);

  const posts = new THREE.Group();
  for (let i = 0; i < 24; i++) {
    const z = -8 - i * 6;
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6);
    const poleMat = new THREE.MeshBasicMaterial({ color: gridColor });
    [-3.8, 3.8].forEach((x) => {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, 0.6, z);
      posts.add(pole);
    });
    if (i % 3 === 0) {
      const palm = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 2.4),
        new THREE.MeshBasicMaterial({ color: 0x2a5a3a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      palm.position.set(-4.5, 1.5, z);
      palm.userData.billboard = true;
      posts.add(palm);
    }
  }
  scene.add(posts);

  const sunGeo = new THREE.CircleGeometry(1, 48);
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xff9030, transparent: true, opacity: 0.95 });
  const sun = new THREE.Mesh(sunGeo, sunMat);
  sun.position.set(0, 4, -55);
  scene.add(sun);

  const sunGlow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({ color: 0xff4080, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending }),
  );
  sunGlow.position.copy(sun.position);
  sunGlow.scale.setScalar(2.5);
  scene.add(sunGlow);

  const shafts = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffc080,
        transparent: true,
        opacity: 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    plane.rotation.x = -0.4;
    plane.rotation.z = (i - 2) * 0.08;
    plane.position.set((i - 2) * 2, 8, -50);
    shafts.add(plane);
  }
  scene.add(shafts);

  function applyTheme() {
    const light = isLight();
    skyMat.uniforms.uTop.value = hexToVec3(css("--km-landscape-sky-top", light ? "#8ec5f0" : "#050510"));
    skyMat.uniforms.uMid.value = hexToVec3(css("--km-landscape-sky-mid", light ? "#f5c4a8" : "#12082a"));
    skyMat.uniforms.uBot.value = hexToVec3(css("--km-landscape-sky-bot", light ? "#e8a090" : "#2a1048"));
    roadMat.uniforms.uMid.value.copy(skyMat.uniforms.uMid.value);
    mountMat.uniforms.uMid.value.copy(skyMat.uniforms.uMid.value);
    scene.fog = new THREE.FogExp2(skyMat.uniforms.uMid.value.getHex(), 0.012);
  }
  applyTheme();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  glCanvas.hidden = false;
  glCanvas.removeAttribute("hidden");
  fallback.style.opacity = "0";
  fallback.style.pointerEvents = "none";

  let scroll = 0;
  let raf = 0;
  let running = false;
  let hidden = document.visibilityState === "hidden";
  let lastFrame = 0;

  function updateScene(fidelity, t) {
    skyMat.uniforms.uFidelity.value = fidelity;
    roadMat.uniforms.uFidelity.value = fidelity;
    roadMat.uniforms.uBtc.value = btc;
    mountMat.uniforms.uFidelity.value = fidelity;

    const radius = 3 + btc * 8;
    const sunY = 2.5 + btc * 4;
    sun.scale.setScalar(radius);
    sunGlow.scale.setScalar(radius * (2 + btc * 2));
    sun.position.y = sunY;
    sunGlow.position.y = sunY;
    roadMat.uniforms.uSunDir.value.set(0, sunY * 0.08, -1).normalize();

    mountains.children.forEach((c) => {
      if (c.userData.wire) {
        c.visible = fidelity < 1.2;
        c.material.opacity = 0.2 + (1.2 - fidelity) * 0.5;
      }
    });
    posts.children.forEach((c) => {
      if (c.userData.billboard) {
        c.visible = fidelity > 1.3;
        c.material.opacity = Math.min(1, (fidelity - 1.3) * 0.8);
      }
    });
    shafts.visible = fidelity > 2.2;
    shafts.children.forEach((p, i) => {
      p.material.opacity = 0.04 + (fidelity - 2.2) * 0.06 + Math.sin(t * 0.001 + i) * 0.01;
    });

    if (!reduced) {
      scroll = (t * 0.035) % 140;
      roadMat.uniforms.uScroll.value = scroll;
      posts.position.z = (scroll * 0.15) % 6;
      posts.position.z -= 6;
    }
  }

  function renderFrame(t) {
    const fidelity = fidelityFromReach(reach, tierOverride);
    updateScene(fidelity, t);
    renderer.render(scene, camera);
    window.__kmLandscapeReady = true;
    window.__kmLandscapeFidelity = fidelity;
  }

  function loop(t) {
    if (hidden || reduced) {
      raf = requestAnimationFrame(loop);
      return;
    }
    const minDelta = 1000 / maxFps;
    if (t - lastFrame < minDelta) {
      raf = requestAnimationFrame(loop);
      return;
    }
    lastFrame = t;
    renderFrame(t);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    renderFrame(0);
    if (!reduced) {
      running = true;
      raf = requestAnimationFrame(loop);
    }
  }

  document.addEventListener("visibilitychange", () => {
    hidden = document.visibilityState === "hidden";
    if (!hidden && !reduced && !running) start();
  });

  window.addEventListener("resize", () => {
    resize();
    renderFrame(performance.now());
  });

  document.getElementById("km-theme-toggle")?.addEventListener("click", () => {
    setTimeout(() => {
      applyTheme();
      renderFrame(performance.now());
    }, 40);
  });

  start();

  return {
    ok: true,
    dispose: () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
    },
  };
}

export default mountLandscapeWebGL;
