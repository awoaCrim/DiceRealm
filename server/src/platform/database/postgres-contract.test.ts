import { describe } from 'vitest';
import pg from 'pg';
import { PostgresDatabaseAdapter } from './PostgresDatabaseAdapter.js';
import { defineDatabaseContractSuite } from './databaseContractSuite.js';

// POSTGRES_TEST_URL 必须指向一个可丢弃的测试库：契约套件会真实建表/插入/清理。
const url = process.env.POSTGRES_TEST_URL;

describe.skipIf(!url)('postgres database port contract', () => {
  defineDatabaseContractSuite({
    label: 'postgres',
    create: async () =>
      new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 })),
  });
});
