import 'dotenv/config';

export interface AppConfig {
  port: number;
  databasePath: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? 'dnd.sqlite'
  };
}
