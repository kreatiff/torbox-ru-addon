// Runs before every test file. src/config.ts validates process.env eagerly on
// import, so anything that reaches the db layer (even transitively) needs
// DATABASE_URL/TORBOX_API_KEY to already be syntactically valid — real values
// only matter for the subset of tests that actually talk to Postgres.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
}
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
process.env.TORBOX_API_KEY ??= 'test-key';
process.env.ADDON_TOKEN ??= 'test-addon-token';
process.env.PUBLIC_BASE ??= 'http://localhost:3000';
process.env.ADMIN_USER ??= 'test-admin';
process.env.ADMIN_PASS ??= 'test-admin-pass';
process.env.NODE_ENV = 'test';
