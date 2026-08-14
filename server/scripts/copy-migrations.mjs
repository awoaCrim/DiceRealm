// Copies the platform SQL migration files and the committed manifest from src
// into dist so the compiled MigrationRunner (which resolves the migrations
// directory relative to import.meta.url) finds them in production builds.
// `tsc` only emits .js for .ts sources, so .sql files must be copied explicitly.
//
// Usage: `node scripts/copy-migrations.mjs` (run as part of `npm run build`).
//
// Guarantees:
// - Removes stale `.sql` files and old `migrations.manifest.json` from dist
//   (keeps the compiled .js/.d.ts/.map next to them).
// - Copies the canonical SQL files (original bytes) and the committed manifest.
// - Verifies BOTH src and dist against the committed manifest with the same
//   exact-set + normalized-LF SHA-256 contract; exits non-zero on any deviation.
// - Only ever mutates the resolved `server/dist` migrations directory.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCanonicalMigrationFilename,
  sortMigrationFilenames,
  verifyMigrationManifestSync,
} from './migration-manifest-shared.mjs';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(serverRoot, 'src', 'platform', 'database', 'migrations');
const destDir = join(serverRoot, 'dist', 'platform', 'database', 'migrations');
const MANIFEST_NAME = 'migrations.manifest.json';

// Guard: never operate outside the generated server/dist directory.
if (resolve(destDir) !== resolve(serverRoot, 'dist', 'platform', 'database', 'migrations')) {
  console.error(`[copy-migrations] Refusing to touch unexpected path: ${destDir}`);
  process.exit(1);
}

if (!existsSync(srcDir)) {
  console.error(`[copy-migrations] Source migrations directory not found: ${srcDir}`);
  process.exit(1);
}

const manifestPath = join(srcDir, MANIFEST_NAME);
if (!existsSync(manifestPath)) {
  console.error(`[copy-migrations] Committed manifest not found: ${manifestPath}`);
  process.exit(1);
}

try {
  // Verify the SOURCE tree against the committed manifest before copying.
  verifyMigrationManifestSync({ migrationsDir: srcDir, manifestPath });
} catch (error) {
  console.error(`[copy-migrations] Source verification failed: ${error.message}`);
  process.exit(1);
}

const sqlFiles = sortMigrationFilenames(
  readdirSync(srcDir).filter((name) => isCanonicalMigrationFilename(name)),
);

mkdirSync(destDir, { recursive: true });

// Clean stale migration artifacts from dist: any .sql and old manifests go away.
let cleaned = 0;
for (const name of readdirSync(destDir)) {
  if (name.endsWith('.sql') || name === MANIFEST_NAME) {
    rmSync(join(destDir, name), { force: true });
    cleaned += 1;
  }
}

for (const name of sqlFiles) {
  copyFileSync(join(srcDir, name), join(destDir, name));
}
copyFileSync(manifestPath, join(destDir, MANIFEST_NAME));

// Verify the DIST tree against the same committed manifest.
try {
  verifyMigrationManifestSync({ migrationsDir: destDir, manifestPath: join(destDir, MANIFEST_NAME) });
} catch (error) {
  console.error(`[copy-migrations] Dist verification failed: ${error.message}`);
  process.exit(1);
}

if (cleaned > 0) {
  console.log(`[copy-migrations] removed ${cleaned} stale artifact(s) from ${destDir}`);
}
console.log(`[copy-migrations] Copied ${sqlFiles.length} migration(s) + manifest to ${destDir}`);
