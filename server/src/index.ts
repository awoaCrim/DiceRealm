import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { getDb } from './db/connection.js';
import { migrate } from './db/schema.js';
import { seedBuiltinRules } from './db/seedRules.js';

const config = loadConfig();
const db = getDb();
migrate(db);
seedBuiltinRules(db);

createApp(db).listen(config.port, () => {
  console.log(`DND AI-DM server listening on http://localhost:${config.port}`);
});
