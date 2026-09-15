'use strict';

// ============================================================================
// File upload — Azure Blob Storage implementation (spec §4).
//
// The reference app uploaded directly from the browser to Supabase Storage
// (client-side, `upsert:true`, public URL), then separately PATCHed the
// resulting `{name, url, type, uploaded_at}` metadata onto the application's
// `attachments` jsonb array (or `profile_picture_url`) via the normal save/
// patch endpoint (see APPLICATION_PATCH_COLUMNS in routes/applications.js,
// which already accepts both fields — unchanged by this file).
//
// This implementation deliberately does NOT reproduce the "public bucket,
// public URL" shape. Candidate uploads here are resumes, NRIC copies,
// profile photos — real PII — so the two containers below are created
// PRIVATE (no anonymous read access), and each uploaded blob's URL is
// instead a read-only SAS (Shared Access Signature) URL, generated once at
// upload time with a long expiry. This is the "keep private" alternative
// the original TODO comment flagged, adopted here rather than public-read
// containers. The client-visible contract is unchanged either way: the
// upload endpoint returns { name, url, type, uploaded_at }, and that url is
// simply usable wherever the reference app used a public Supabase Storage
// URL (an <img src>, a download link, etc.) — it's just SAS-signed instead
// of unconditionally public.
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { BlobServiceClient, BlobSASPermissions } = require('@azure/storage-blob');
const asyncHandler = require('../lib/asyncHandler');
const { requireCandidateAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireCandidateAuth);

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB per file — kept in lockstep with
// the client-side check in job-app/app.js (MAX_UPLOAD_BYTES). This is the
// backstop: the frontend already rejects an oversized file before it starts
// uploading, but this limit still applies to any other client hitting the
// API directly.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

// SAS URL lifetime for uploaded files. Long-lived by design, since these
// URLs are meant to behave like the original "public forever" Supabase
// Storage URLs from the candidate/admin UI's point of view (embedded
// directly in application records with no refresh mechanism) — just scoped
// to read-only and to this specific blob rather than the whole container.
const SAS_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years

const PROFILE_PICTURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER_PROFILE_PICTURES || 'profile-pictures';
const ATTACHMENT_CONTAINER = process.env.AZURE_STORAGE_CONTAINER_ATTACHMENTS || 'attachments';

let blobServiceClient = null;
let containerReadyPromises = {};

function getBlobServiceClient() {
  if (blobServiceClient) return blobServiceClient;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) return null;
  blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  return blobServiceClient;
}

async function getReadyContainerClient(containerName) {
  const client = getBlobServiceClient();
  if (!client) return null;
  const containerClient = client.getContainerClient(containerName);
  if (!containerReadyPromises[containerName]) {
    // Private container — no `access` option means no anonymous read, per
    // the module header. Safe to call repeatedly (createIfNotExists).
    containerReadyPromises[containerName] = containerClient.createIfNotExists();
  }
  await containerReadyPromises[containerName];
  return containerClient;
}

// Strip to a safe character set per spec §4's sanitizeFilename() rule,
// keeping the extension. The ORIGINAL name is preserved separately for
// display (see the `name` field returned below) — this sanitized version is
// only ever used for the actual blob key.
function sanitizeFilename(originalName) {
  const name = String(originalName || 'file');
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : '';
  const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'file';
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
  return safeBase + safeExt;
}

async function uploadToContainer(req, res, containerName) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (expected multipart/form-data field "file")' });
  }

  const containerClient = await getReadyContainerClient(containerName);
  if (!containerClient) {
    return res.status(503).json({
      error: 'File upload is not configured: AZURE_STORAGE_CONNECTION_STRING is not set',
    });
  }

  const blobName = `${req.user.id}/${crypto.randomUUID()}-${sanitizeFilename(req.file.originalname)}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(req.file.buffer, {
    blobHTTPHeaders: { blobContentType: req.file.mimetype || 'application/octet-stream' },
  });

  const url = await blockBlobClient.generateSasUrl({
    permissions: BlobSASPermissions.parse('r'),
    expiresOn: new Date(Date.now() + SAS_EXPIRY_MS),
  });

  return res.status(201).json({
    name: req.file.originalname,
    url,
    type: req.file.mimetype || 'application/octet-stream',
    uploaded_at: new Date().toISOString(),
  });
}

// POST /api/uploads/profile-picture  (multipart/form-data, field "file")
router.post('/profile-picture', upload.single('file'), asyncHandler(async (req, res) => {
  return uploadToContainer(req, res, PROFILE_PICTURE_CONTAINER);
}));

// POST /api/uploads/attachment  (multipart/form-data, field "file")
router.post('/attachment', upload.single('file'), asyncHandler(async (req, res) => {
  return uploadToContainer(req, res, ATTACHMENT_CONTAINER);
}));

// Multer errors (e.g. file too large) throw before reaching asyncHandler's
// try/catch shape in a way Express needs a dedicated error middleware for.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
      return res.status(400).json({
        error: `File exceeds the ${maxMb}MB upload limit. Please compress it into a ZIP file and upload that instead.`,
      });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  return next(err);
});

module.exports = router;
