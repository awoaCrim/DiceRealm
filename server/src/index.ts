import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { getDb, getPlatformDb } from './db/connection.js';
import { migrate } from './db/schema.js';
import { seedBuiltinRules } from './db/seedRules.js';

const config = loadConfig();
const db = getDb();
migrate(db);
seedBuiltinRules(db);

const platformDb = getPlatformDb();
await platformDb.migrate();

createApp(db, { platformDb }).listen(config.port, config.host, () => {
  console.log(`DND AI-DM server listening on http://${config.host}:${config.port}`);
});
