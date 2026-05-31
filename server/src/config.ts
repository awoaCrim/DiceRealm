import 'dotenv/config';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '192.168.31.246',
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? 'dnd.sqlite'
  };
}
