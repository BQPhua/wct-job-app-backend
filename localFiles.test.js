'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wct-uploads-'));
process.env.UPLOAD_DIR = UPLOAD_DIR;

const { resetDb, db } = require('./helpers/db');
const { request } = require('./helpers/app');
const fx = require('./helpers/fixtures');
const fileStore = require('../src/lib/fileStore');
const { migrateRows } = require('../scripts/migrate-blobs-to-local');

let cand;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

before(async () => {
  await resetDb();
  cand = await fx.candidate({ email: 'files@gmail.com' });
});
after(async () => {
  delete process.env.UPLOAD_DIR;
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  await db().pool.end();
});

test('upload saves to disk and returns a signed, relative link that serves the file', async () => {
  const up = await request().post('/api/uploads/profile-picture').set('Authorization', `Bearer ${cand.token}`)
    .attach('file', PNG, { filename: 'My Photo (1).png', contentType: 'image/png' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.name, 'My Photo (1).png');
  assert.match(up.body.url, /^\/api\/files\/profile-pictures\/[0-9a-f-]+\/[0-9a-f-]+-My_Photo__1_\.png\?exp=\d+&sig=[\w-]+$/);
  const onDisk = path.join(UPLOAD_DIR, 'profile-pictures', cand.id);
  assert.equal(fs.readdirSync(onDisk).length, 1);

  const got = await request().get(up.body.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.match(got.headers['content-disposition'], /^inline/);
  assert.deepEqual(Buffer.from(got.body), PNG);
});

test('tampered, expired or unsigned links are refused', async () => {
  const up = await request().post('/api/uploads/attachment').set('Authorization', `Bearer ${cand.token}`)
    .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'cv.pdf', contentType: 'application/pdf' });
  const url = up.body.url;
  assert.equal((await request().get(url.replace(/sig=.{4}/, 'sig=AAAA'))).status, 403);
  assert.equal((await request().get(url.split('?')[0])).status, 403);
  const key = url.split('?')[0].replace('/api/files/', '');
  const expired = fileStore.signedUrl(key, Date.now() - 1000);
  assert.equal((await request().get(expired)).status, 403);
  // A valid signature for one file can't be reused for another path.
  const other = url.replace(/\/[^/]+\?/, '/someone-else.pdf?');
  assert.equal((await request().get(other)).status, 403);
});

test('path traversal and unknown folders are refused', async () => {
  for (const key of ['profile-pictures/../../etc/passwd', 'secrets/x/y.txt', 'attachments/%2e%2e/x.txt']) {
    const res = await request().get(fileStore.signedUrl(key));
    assert.ok([400, 403, 404].includes(res.status), `${key} -> ${res.status}`);
  }
});

test('anything that is not an image or PDF downloads instead of opening in the browser', async () => {
  const up = await request().post('/api/uploads/attachment').set('Authorization', `Bearer ${cand.token}`)
    .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });
  const got = await request().get(up.body.url);
  assert.equal(got.status, 200);
  assert.match(got.headers['content-disposition'], /^attachment/);
  assert.notEqual(got.headers['content-type'].split(';')[0], 'text/html');
});

test('migration copies Azure blobs to disk and rewrites the links in applications', async () => {
  const azure = (c, n) => `https://wctjobappstorage.blob.core.windows.net/${c}/${n}?sv=2024&se=2036&sp=r&sig=abc%3D`;
  const app = await fx.hiredApplication({ email: 'files@gmail.com' });
  await db().query(
    `UPDATE applications SET profile_picture_url = $2, attachments = $3::jsonb WHERE id = $1`,
    [app.id, azure('profile-pictures', `${cand.id}/aaa-photo.png`), JSON.stringify([
      { name: 'CV.pdf', url: azure('attachments', `${cand.id}/bbb-CV.pdf`), type: 'application/pdf' },
      { name: 'Already local.pdf', url: '/api/files/attachments/x/y.pdf?exp=1&sig=z', type: 'application/pdf' },
    ])]
  );
  const downloaded = [];
  const download = async (container, blobName) => { downloaded.push(`${container}/${blobName}`); return Buffer.from(`data:${blobName}`); };

  const report = await migrateRows(db(), { download, uploadDir: UPLOAD_DIR });
  assert.deepEqual(report, { applications: 1, files: 2, failed: [] });
  assert.deepEqual(downloaded.sort(), [`attachments/${cand.id}/bbb-CV.pdf`, `profile-pictures/${cand.id}/aaa-photo.png`]);

  const { rows } = await db().query('SELECT profile_picture_url, attachments FROM applications WHERE id = $1', [app.id]);
  assert.match(rows[0].profile_picture_url, new RegExp(`^/api/files/profile-pictures/${cand.id}/aaa-photo\\.png\\?exp=`));
  assert.match(rows[0].attachments[0].url, /^\/api\/files\/attachments\/.+bbb-CV\.pdf\?exp=/);
  assert.equal(rows[0].attachments[0].name, 'CV.pdf');
  assert.equal(rows[0].attachments[1].url, '/api/files/attachments/x/y.pdf?exp=1&sig=z');
  const got = await request().get(rows[0].attachments[0].url);
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(got.body).toString(), `data:${cand.id}/bbb-CV.pdf`);

  // Running it again finds nothing left to move.
  const again = await migrateRows(db(), { download, uploadDir: UPLOAD_DIR });
  assert.deepEqual(again, { applications: 0, files: 0, failed: [] });
});
