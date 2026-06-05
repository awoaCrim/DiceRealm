import 'dotenv/config';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? 'dnd.sqlite'
  };
}
