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
uniform float uTime;
varying vec3 vWorld;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
void main() {
  float h = normalize(vWorld).y * 0.5 + 0.5;
  vec3 col = mix(uBot, uMid, smoothstep(0.0, 0.52, h));
  col = mix(col, uTop, smoothstep(0.42, 1.0, h));
  float starGate = smoothstep(1.6, 2.2, uFidelity);
  float twinkle = 0.85 + 0.15 * sin(uTime * 0.002 + hash(vWorld.xz) * 40.0);
  float stars = starGate * step(0.88, h) * step(0.92, hash(floor(vWorld.xz * 120.0)));
  col += vec3(0.9, 0.95, 1.0) * stars * twinkle * (0.25 + smoothstep(2.5, 3.0, uFidelity) * 0.45);
  gl_FragColor = vec4(col, 1.0);
}`;

const ROAD_VERT = /* glsl */ `
uniform float uCamZ;
varying vec2 vUv;
varying float vDist;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vDist = uCamZ - position.z;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ROAD_FRAG = /* glsl */ `
uniform float uScroll;
uniform float uFidelity;
uniform float uBtc;
uniform vec3 uGrid;
uniform vec3 uSunDir;
varying vec2 vUv;
varying float vDist;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

void main() {
  float z = vDist + uScroll;
  float center = abs(vUv.x - 0.5);
  float onRoad = 1.0 - smoothstep(0.07, 0.11, center);
  float onFloor = 1.0 - onRoad;

  float wire = 1.0 - smoothstep(0.0, 0.35, uFidelity);
  float flat = smoothstep(0.25, 0.95, uFidelity) * (1.0 - smoothstep(1.85, 2.35, uFidelity));
  float tex = smoothstep(1.55, 2.15, uFidelity) * (1.0 - smoothstep(2.45, 3.0, uFidelity));
  float ps2 = smoothstep(2.35, 2.95, uFidelity);

  vec3 base = mix(vec3(0.04, 0.12, 0.1), vec3(0.09, 0.1, 0.12), onRoad);

  float gridX = abs(fract(vUv.x * 26.0) - 0.5);
  float gridZ = abs(fract(vDist * 0.38) - 0.5);
  float grid = max(smoothstep(0.44, 0.5, gridX), smoothstep(0.42, 0.5, gridZ));
  float gridBoost = 0.85 + wire * 1.1 + flat * 0.55 + tex * 0.4 + ps2 * 0.25;
  base += uGrid * grid * onFloor * gridBoost;
  base += uGrid * grid * onRoad * gridBoost * 0.35;

  float edgeW = smoothstep(0.088, 0.095, center) * (1.0 - smoothstep(0.095, 0.102, center));
  edgeW += smoothstep(0.102, 0.108, center) * (1.0 - smoothstep(0.108, 0.114, center));
  base += vec3(0.92, 0.94, 0.98) * edgeW * onRoad * (0.55 + wire * 0.45 + flat + tex + ps2);

  float lane = step(0.012, center) * step(center, 0.042);
  float dash = step(0.45, fract(z * 0.85));
  base += vec3(1.0, 0.82, 0.35) * lane * dash * onRoad * (0.65 + wire * 0.55 + flat + tex + ps2);

  float n = hash(vUv * 80.0 + z * 0.08);
  base += (n - 0.5) * 0.08 * (tex + ps2) * onRoad;

  float sheen = pow(max(0.0, dot(vec3(0.0, 1.0, 0.0), normalize(uSunDir))), 5.0);
  base += uGrid * sheen * onRoad * (tex * 0.25 + ps2 * 0.5);

  float wet = pow(max(0.0, 1.0 - length(vUv - vec2(0.5, fract(uScroll * 0.015 + uBtc * 0.12)))), 4.0);
  base += vec3(1.0, 0.55, 0.25) * wet * onRoad * ps2 * uBtc * 0.65;

  gl_FragColor = vec4(base, 1.0);
}`;

const MOUNT_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vPos = position;
  vNormal = normalize(normalMatrix * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const MOUNT_FRAG = /* glsl */ `
uniform float uFidelity;
uniform vec3 uGrid;
uniform vec3 uMid;
uniform vec3 uSunDir;
varying vec3 vPos;
varying vec3 vWorld;
varying vec3 vNormal;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

void main() {
  float wire = 1.0 - smoothstep(0.0, 0.55, uFidelity);
  float flat = smoothstep(0.45, 1.05, uFidelity) * (1.0 - smoothstep(1.85, 2.35, uFidelity));
  float tex = smoothstep(1.55, 2.2, uFidelity) * (1.0 - smoothstep(2.45, 3.0, uFidelity));
  float ps2 = smoothstep(2.35, 3.0, uFidelity);

  float h = clamp(vPos.y / 10.0, 0.0, 1.0);
  float n = hash(vWorld.xz * 0.2) * tex + hash(vWorld.xz * 0.5) * ps2 * 0.6;

  vec3 dark = vec3(0.06, 0.02, 0.12);
  vec3 fill = mix(dark, uGrid * 0.22, flat);
  fill = mix(fill, vec3(0.14, 0.11, 0.16), tex * h);
  fill = mix(fill, vec3(0.22, 0.19, 0.24), ps2 * h);
  fill += n * 0.12;

  float ndl = max(0.15, dot(vNormal, normalize(uSunDir)));
  fill *= 0.55 + ndl * (flat * 0.35 + tex * 0.45 + ps2 * 0.55);

  if (wire > 0.45) {
    float rim = smoothstep(0.75, 1.0, h);
    vec3 wcol = uGrid * (0.65 + rim * 0.35);
    gl_FragColor = vec4(wcol, wire * (0.35 + rim * 0.45));
    return;
  }

  float fog = smoothstep(8.0, 70.0, -vWorld.z);
  fill = mix(fill, uMid * 0.3, fog * (0.25 + tex * 0.45 + ps2 * 0.65));

  gl_FragColor = vec4(fill, flat + tex + ps2);
}`;

const SUN_GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uStrength;
void main() {
  vec2 p = vUv - 0.5;
  float d = length(p);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.06, d);
  a = a * a * a * uStrength;
  vec3 col = mix(vec3(1.0, 0.35, 0.55), vec3(1.0, 0.65, 0.25), smoothstep(0.0, 0.5, d));
  gl_FragColor = vec4(col, a);
}`;

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function hexToVec3(hex) {
  return new THREE.Color(hex);
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
      preserveDrawingBuffer: true,
    });
  } catch {
    return { ok: false };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 220);
  const camZ = 2.35;
  const camY = 0.52;
  camera.position.set(0, camY, camZ);
  camera.lookAt(0, 0.02, -48);

  const skyGeo = new THREE.SphereGeometry(120, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uBot: { value: new THREE.Color() },
      uFidelity: { value: 0 },
      uTime: { value: 0 },
    },
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  const roadGeo = new THREE.PlaneGeometry(56, 176, 1, 56);
  roadGeo.rotateX(-Math.PI / 2);
  roadGeo.translate(0, 0.015, -68);
  const gridColor = hexToVec3(css("--km-landscape-grid", "#3df29a"));
  gridColor.multiplyScalar(1.15);
  const sunDir = new THREE.Vector3(0, 0.25, -1).normalize();
  const roadMat = new THREE.ShaderMaterial({
    vertexShader: ROAD_VERT,
    fragmentShader: ROAD_FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uScroll: { value: 0 },
      uFidelity: { value: 0 },
      uBtc: { value: btc },
      uGrid: { value: gridColor },
      uSunDir: { value: sunDir.clone() },
      uCamZ: { value: camZ },
    },
  });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.name = "km-road";
  road.renderOrder = 1;
  scene.add(road);

  const floorGrid = new THREE.GridHelper(140, 70, 0x5bffaa, 0x3df29a);
  floorGrid.position.set(0, 0.02, -62);
  floorGrid.material.transparent = true;
  floorGrid.material.opacity = 0.95;
  floorGrid.name = "km-floor-grid";
  scene.add(floorGrid);

  const roadDeck = new THREE.Mesh(
    new THREE.PlaneGeometry(7.2, 150),
    new THREE.MeshBasicMaterial({ color: 0x06080c }),
  );
  roadDeck.rotation.x = -Math.PI / 2;
  roadDeck.position.set(0, 0.025, -62);
  roadDeck.name = "km-road-deck";
  scene.add(roadDeck);

  const edgeMat = new THREE.LineBasicMaterial({ color: 0xe8ecff, transparent: true, opacity: 0.85 });
  const edgeGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-3.5, 0.04, 8),
    new THREE.Vector3(-0.35, 0.04, -132),
    new THREE.Vector3(3.5, 0.04, 8),
    new THREE.Vector3(0.35, 0.04, -132),
  ]);
  const roadEdges = new THREE.LineSegments(
    edgeGeo,
    edgeMat,
  );
  roadEdges.name = "km-road-edges";
  scene.add(roadEdges);

  const dashes = new THREE.Group();
  for (let i = 0; i < 44; i++) {
    const z = 10 - i * 3.2;
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 1.1),
      new THREE.MeshBasicMaterial({ color: 0xffd060 }),
    );
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.05, z);
    dashes.add(dash);
  }
  dashes.name = "km-road-dashes";
  scene.add(dashes);

  const mountMat = new THREE.ShaderMaterial({
    vertexShader: MOUNT_VERT,
    fragmentShader: MOUNT_FRAG,
    transparent: true,
    uniforms: {
      uFidelity: { value: 0 },
      uGrid: { value: gridColor },
      uMid: { value: new THREE.Color() },
      uSunDir: { value: sunDir.clone() },
    },
  });

  const mountains = new THREE.Group();
  const peaks = [
    [-14, -22, 7.5],
    [-20, -36, 10.5],
    [-8, -50, 9],
    [10, -26, 9.5],
    [18, -40, 12],
    [6, -62, 11],
    [-16, -74, 10],
    [14, -82, 11.5],
  ];
  peaks.forEach(([x, z, h]) => {
    const geo = new THREE.ConeGeometry(5.5 + h * 0.15, h, 4, 1);
    const mesh = new THREE.Mesh(geo, mountMat);
    mesh.position.set(x, h * 0.5 - 0.2, z);
    mountains.add(mesh);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: 0.55 }),
    );
    wire.position.copy(mesh.position);
    wire.userData.wire = true;
    mountains.add(wire);
  });
  scene.add(mountains);

  const starCount = 400;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(0.15 + Math.random() * 0.75);
    const r = 95;
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.cos(phi);
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({ color: 0xe8f0ff, size: 0.22, transparent: true, opacity: 0, sizeAttenuation: true }),
  );
  scene.add(stars);

  const posts = new THREE.Group();
  for (let i = 0; i < 28; i++) {
    const z = -6 - i * 5.5;
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6);
    const poleMat = new THREE.MeshBasicMaterial({ color: gridColor });
    [-3.6, 3.6].forEach((x) => {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, 0.55, z);
      pole.userData.pole = true;
      posts.add(pole);
    });
    if (i % 2 === 0) {
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 0.9),
        new THREE.MeshBasicMaterial({
          color: i % 4 === 0 ? 0xff4080 : 0x40c0ff,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        }),
      );
      sign.position.set(i % 4 === 0 ? -4.2 : 4.2, 1.1, z);
      sign.userData.billboard = true;
      posts.add(sign);
    }
    if (i % 3 === 0) {
      const palm = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1, 2.2),
        new THREE.MeshBasicMaterial({ color: 0x2a6a4a, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      palm.position.set(-4.8, 1.4, z - 1);
      palm.userData.billboard = true;
      palm.userData.palm = true;
      posts.add(palm);
    }
  }
  scene.add(posts);

  const sunGeo = new THREE.CircleGeometry(1, 48);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: { uBtc: { value: btc } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uBtc;
      void main(){
        vec2 p = vUv - 0.5;
        if(length(p) > 0.5) discard;
        vec3 col = mix(vec3(1.0,0.55,0.15), vec3(0.9,0.15,0.35), p.y + 0.5);
        if(uBtc >= 0.15){
          float v = p.y + 0.5;
          float stripe = mod(v * (8.0 + uBtc * 10.0), 1.0);
          if(stripe < 0.35) discard;
        }
        gl_FragColor = vec4(col, 0.98);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const sun = new THREE.Mesh(sunGeo, sunMat);
  sun.position.set(0, 1.05, -50);
  sun.renderOrder = 3;
  scene.add(sun);

  const sunGlowMat = new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.55 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: SUN_GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sunGlow = new THREE.Mesh(new THREE.CircleGeometry(1, 32), sunGlowMat);
  sunGlow.position.copy(sun.position);
  sunGlow.scale.setScalar(6);
  sunGlow.renderOrder = 2;
  scene.add(sunGlow);

  const shafts = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 36),
      new THREE.MeshBasicMaterial({
        color: 0xff9040,
        transparent: true,
        opacity: 0.04,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    plane.rotation.x = -0.42;
    plane.rotation.z = (i - 1.5) * 0.06;
    plane.position.set((i - 1.5) * 2.4, 6.8, -46);
    shafts.add(plane);
  }
  scene.add(shafts);

  function applyTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    const light = t === "light";
    const darkSky = { top: "#050510", mid: "#12082a", bot: "#2a1048" };
    const lightSky = { top: "#87ceeb", mid: "#f9d5b8", bot: "#e8a090" };
    const pal = light ? lightSky : darkSky;
    skyMat.uniforms.uTop.value.set(pal.top);
    skyMat.uniforms.uMid.value.set(pal.mid);
    skyMat.uniforms.uBot.value.set(pal.bot);
    mountMat.uniforms.uMid.value.set(pal.mid);
    scene.fog = new THREE.FogExp2(skyMat.uniforms.uMid.value.getHex(), light ? 0.006 : 0.0075);
    renderer.setClearColor(skyMat.uniforms.uBot.value, 1);
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

  window.__kmLandscapeWebGL = true;
  window.__kmLandscapeGlContext = renderer.getContext();
  glCanvas.dataset.webglActive = "1";
  fallback.classList.add("km-landscape-fallback-hidden");
  fallback.dataset.fallbackHidden = "1";

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
    skyMat.uniforms.uTime.value = t;
    roadMat.uniforms.uFidelity.value = fidelity;
    roadMat.uniforms.uBtc.value = btc;
    mountMat.uniforms.uFidelity.value = fidelity;

    const radius = 2.4 + btc * 6;
    const sunY = 1.05 + btc * 2.8;
    sun.scale.setScalar(radius);
    sunGlow.position.y = sunY;
    sun.position.y = sunY;
    sunGlow.scale.setScalar(radius * (3.5 + btc * 1.5));
    sunGlowMat.uniforms.uStrength.value = 0.1 + btc * 0.16;
    const sd = new THREE.Vector3(0, sunY * 0.12 + 0.08, -1).normalize();
    roadMat.uniforms.uSunDir.value.copy(sd);
    mountMat.uniforms.uSunDir.value.copy(sd);
    sunMat.uniforms.uBtc.value = btc;

    mountains.children.forEach((c) => {
      if (c.userData.wire) {
        c.visible = fidelity < 1.35 || fidelity >= 2.3;
        c.material.opacity = fidelity >= 2.3 ? 0.28 : 0.4 + Math.max(0, 1.35 - fidelity) * 0.45;
      } else if (c.isMesh) {
        c.visible = fidelity >= 0.65;
      }
    });

    stars.material.opacity = Math.min(1, Math.max(0, (fidelity - 1.7) * 0.55));
    stars.visible = fidelity > 1.5;

    posts.children.forEach((c) => {
      if (c.userData.pole) {
        c.visible = fidelity > 0.75;
        c.material.opacity = Math.min(1, (fidelity - 0.75) * 1.2);
      }
      if (c.userData.billboard) {
        const palm = c.userData.palm;
        const gate = palm ? 2.05 : 1.85;
        c.visible = fidelity > gate && fidelity < 2.85;
        c.material.opacity = Math.min(0.72, (fidelity - gate) * 0.55);
      }
    });

    shafts.visible = fidelity > 2.65;
    shafts.children.forEach((p, i) => {
      p.material.opacity = 0.012 + (fidelity - 2.65) * 0.022 + Math.sin(t * 0.001 + i) * 0.006;
    });

    if (scene.fog) {
      scene.fog.density = 0.0065 + Math.max(0, fidelity - 1) * 0.0025 + Math.max(0, fidelity - 2.4) * 0.002;
    }

    if (!reduced) {
      scroll = (t * 0.04) % 160;
      roadMat.uniforms.uScroll.value = scroll;
      posts.position.z = ((scroll * 0.12) % 5.5) - 5.5;
    }
  }

  function renderFrame(t) {
    const fidelity = fidelityFromReach(reach, tierOverride);
    glCanvas.dataset.tier = String(Math.round(fidelity));
    updateScene(fidelity, t);
    posts.children.forEach((c) => {
      if (c.userData.billboard) c.lookAt(camera.position);
    });
    renderer.render(scene, camera);
    window.__kmLandscapeReady = true;
    window.__kmLandscapeFidelity = fidelity;
    window.__kmLandscapeWebGL = true;
    window.__kmLandscapeFrameCount = (window.__kmLandscapeFrameCount || 0) + 1;
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

  new MutationObserver(() => {
    applyTheme();
    renderFrame(performance.now());
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
