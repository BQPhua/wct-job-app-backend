'use strict';
// Test environment — loaded first by every test file (via helpers/db.js and
// helpers/app.js) so src/db.js builds its pool against the throwaway local
// database, never a real one.
process.env.NODE_ENV = 'test';
process.env.PGHOST = process.env.TEST_PGHOST || '127.0.0.1';
process.env.PGPORT = process.env.TEST_PGPORT || '5432';
process.env.PGUSER = process.env.TEST_PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD || 'postgres';
process.env.PGDATABASE = process.env.E2E_DB || 'wct_test';
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = 'test';
process.env.ADMIN_JWT_SECRET = 'test-admin';
process.env.OFFBOARDING_CRON_SECRET = 'cron-test';
process.env.FRONTEND_BASE_URL = 'http://fe.test';
// The existing offboarding tests cover the full flow (department clearance
// and payroll). The HR-only flow (the live default since 3 Nov 2026) is
// covered by test/offboardingHrOnly.test.js, which switches this off.
if (!process.env.E2E_DB && process.env.OFFBOARDING_CLEARANCE === undefined) process.env.OFFBOARDING_CLEARANCE = 'on';
