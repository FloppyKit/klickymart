import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "public/vendor");
mkdirSync(destDir, { recursive: true });

const files = ["three.module.min.js", "three.core.min.js"];
for (const f of files) {
  const src = join(root, "node_modules/three/build", f);
  if (!existsSync(src)) {
    console.warn("copy-vendor: missing", f);
    continue;
  }
  copyFileSync(src, join(destDir, f));
  console.log("Copied", f);
}
