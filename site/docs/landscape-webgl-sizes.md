# Landscape WebGL bundle sizes (lazy-loaded)

Loaded **after first paint** via `requestIdleCallback` — not on the critical HTML/ CSS path.

| File | Bytes (raw) | Gzip (approx.) | When loaded |
|------|-------------|----------------|-------------|
| `/km-landscape.js` | 12,663 | ~3.3 KB | `defer` on every page |
| `/km-landscape-webgl.js` | 14,892 | ~4.4 KB | dynamic `import()` after idle |
| `/vendor/three.module.min.js` | 338,908 | ~79 KB | imported by webgl module |

**Total JS added for WebGL path:** ~366 KB raw (~87 KB gzip combined), in addition to the deferred boot script.

Critical path remains: HTML, tokens.css, km.css, km.js, then deferred km-landscape.js (2D first frame before WebGL upgrades).

Regenerate vendor copy after `npm ci`:

```bash
node scripts/copy-vendor.js
```
