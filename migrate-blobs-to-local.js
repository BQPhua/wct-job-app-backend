'use strict';
// ============================================================================
// One-off: copy every uploaded file from Azure Blob Storage to local disk and
// rewrite the links stored in `applications` (profile_picture_url and each
// attachments[].url) to signed local links (see src/lib/fileStore.js).
//
//   sudo node scripts/migrate-blobs-to-local.js --env /etc/wct/backend.env
//   sudo node scripts/migrate-blobs-to-local.js --env /etc/wct/backend.env --dry-run
//
// Needs UPLOAD_DIR, AZURE_STORAGE_CONNECTION_STRING and the PG* settings.
// Safe to run more than once: links already pointing at /api/files are left
// alone, so a second run only picks up files uploaded since the first.
// ============================================================================
const fs = require('fs');
const path = require('path');

const AZURE_URL = /^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/([^/?#]+)\/([^?#]+)/i;

function folderFor(container) {
  if (container === (process.env.AZURE_STORAGE_CONTAINER_PROFILE_PICTURES || 'profile-pictures')) return 'profile-pictures';
  if (container === (process.env.AZURE_STORAGE_CONTAINER_ATTACHMENTS || 'attachments')) return 'attachments';
  return null;
}

/**
 * Move every Azure link in `applications` to local disk.
 * `download(container, blobName)` returns a Buffer. Returns
 * { applications: rows changed, files: files copied, failed: [{ id, url, error }] }.
 */
async function migrateRows(db, { download, uploadDir, dryRun = false, log = () => {} }) {
  if (uploadDir) process.env.UPLOAD_DIR = uploadDir;
  const fileStore = require('../src/lib/fileStore');
  const { rows } = await db.query(
    `SELECT id, profile_picture_url, attachments FROM applications
      WHERE profile_picture_url ~* '\\.blob\\.core\\.windows\\.net/'
         OR attachments::text ~* '\\.blob\\.core\\.windows\\.net/'`
  );
  const report = { applications: 0, files: 0, failed: [] };

  const move = async (appId, url) => {
    const m = AZURE_URL.exec(url || '');
    if (!m) return url;
    const container = decodeURIComponent(m[1]);
    const blobName = m[2].split('/').map(decodeURIComponent).join('/');
    const folder = folderFor(container);
    const fileKey = folder && `${folder}/${blobName}`;
    const full = fileKey && fileStore.resolve(fileKey);
    if (!full) {
      report.failed.push({ id: appId, url: url.split('?')[0], error: 'unexpected container or file name' });
      return url;
    }
    try {
      if (!dryRun) {
        const data = await download(container, blobName);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, data);
      }
      report.files += 1;
      log(`  copied ${container}/${blobName}`);
      return fileStore.signedUrl(fileKey);
    } catch (err) {
      report.failed.push({ id: appId, url: url.split('?')[0], error: err.message });
      return url;
    }
  };

  for (const row of rows) {
    const pfp = await move(row.id, row.profile_picture_url);
    const atts = [];
    for (const a of row.attachments || []) atts.push(a && a.url ? { ...a, url: await move(row.id, a.url) } : a);
    const changed = pfp !== row.profile_picture_url || JSON.stringify(atts) !== JSON.stringify(row.attachments || []);
    if (changed) {
      report.applications += 1;
      if (!dryRun) {
        await db.query('UPDATE applications SET profile_picture_url = $2, attachments = $3::jsonb WHERE id = $1',
          [row.id, pfp, JSON.stringify(atts)]);
      }
    }
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const envAt = args.indexOf('--env');
  if (envAt >= 0) require('dotenv').config({ path: args[envAt + 1] });
  const dryRun = args.includes('--dry-run');
  for (const k of ['UPLOAD_DIR', 'AZURE_STORAGE_CONNECTION_STRING', 'PGDATABASE']) {
    if (!process.env[k]) { console.error(`${k} is not set (pass --env /etc/wct/backend.env)`); process.exit(1); }
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const blobs = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const download = (container, name) => blobs.getContainerClient(container).getBlobClient(name).downloadToBuffer();
  const db = require('../src/db');
  console.log(`${dryRun ? '[dry run] ' : ''}Copying uploads from Azure Blob to ${process.env.UPLOAD_DIR} ...`);
  const report = await migrateRows(db, { download, dryRun, log: console.log });
  console.log(`\nDone. Applications updated: ${report.applications}. Files copied: ${report.files}. Failed: ${report.failed.length}.`);
  report.failed.forEach((f) => console.log(`  FAILED application ${f.id}: ${f.url} (${f.error})`));
  await db.pool.end();
  process.exit(report.failed.length ? 2 : 0);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { migrateRows };
