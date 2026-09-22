// Apply a full .sql file to the poom dev database (multi-statement).
// Usage: node scripts/apply-sql-file.mjs <file.sql>   (run with env.sh sourced)
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../package.json', import.meta.url));
const pg = require('pg');

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/apply-sql-file.mjs <file.sql>'); process.exit(1); }

const client = new pg.Client({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'poom' });
await client.connect();
try {
  const sql = readFileSync(file, 'utf8');
  await client.query(sql); // pg sends multi-statement strings as one implicit transaction
  console.log('APPLIED', file);
} finally {
  await client.end();
}
