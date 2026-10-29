# Landscape WebGL bundle sizes (lazy-loaded)

Loaded **after first paint** via `requestIdleCallback` — not on the critical HTML/ CSS path.

| File | Bytes (raw) | Gzip (approx.) | When loaded |
|------|-------------|----------------|-------------|
| `/km-landscape.js` | boot + 2D fallback | ~4 KB | `defer` on every page |
| `/km-landscape-webgl.js` | scene + shaders | ~12 KB | dynamic `import()` after idle |
| `/vendor/three.module.min.js` | 338,908 | ~120 KB | imported by webgl module |

**Total JS added for WebGL path:** ~351 KB raw (~136 KB gzip combined), in addition to the existing ~4 KB boot script.

Critical path remains: HTML, tokens.css, km.css, km.js, then deferred km-landscape.js (2D first frame before WebGL upgrades).

Regenerate vendor copy after `npm ci`:

```bash
node scripts/copy-vendor.js
```
