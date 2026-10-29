import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/three/build/three.module.min.js");
const destDir = join(root, "public/vendor");
const dest = join(destDir, "three.module.min.js");
if (!existsSync(src)) {
  console.warn("copy-vendor: three not installed, skip");
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("Copied three.module.min.js", dest);
