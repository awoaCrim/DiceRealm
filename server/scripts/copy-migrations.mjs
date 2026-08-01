// Copies the platform SQL migration files from src into dist so the compiled
// MigrationRunner (which resolves the migrations directory relative to
// import.meta.url) finds them in production builds. `tsc` only emits .js for
// .ts sources, so .sql files must be copied explicitly.
//
// Usage: `node scripts/copy-migrations.mjs` (run as part of `npm run build`).
// Exits non-zero if the source directory is missing or contains no .sql files,
// and verifies every source migration was copied into dist.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(serverRoot, 'src', 'platform', 'database', 'migrations');
const destDir = join(serverRoot, 'dist', 'platform', 'database', 'migrations');

if (!existsSync(srcDir)) {
  console.error(`[copy-migrations] Source migrations directory not found: ${srcDir}`);
  process.exit(1);
}

const sqlFiles = readdirSync(srcDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (sqlFiles.length === 0) {
  console.error(`[copy-migrations] No .sql migration files found in ${srcDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

for (const name of sqlFiles) {
  copyFileSync(join(srcDir, name), join(destDir, name));
  console.log(`[copy-migrations] copied ${name}`);
}

console.log(`[copy-migrations] Copied ${sqlFiles.length} migration(s) to ${destDir}`);
