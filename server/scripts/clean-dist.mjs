// Removes the generated `server/dist` directory before tsc so stale compiled
// legacy artifacts (routes/services/db/domain JS) can never survive a rebuild.
//
// Safety: only ever deletes the path that resolves EXACTLY to
// `<serverRoot>/dist`; any other path is refused with a non-zero exit.
// Source/working-tree changes are never touched.

import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(join(serverRoot, 'dist'));
const expected = resolve(serverRoot, 'dist');

if (target !== expected) {
  console.error(`[clean-dist] Refusing to remove unexpected path: ${target}`);
  process.exit(1);
}

if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
  console.log(`[clean-dist] removed ${target}`);
} else {
  console.log('[clean-dist] nothing to clean');
}
