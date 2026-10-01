'use strict';

// GET /api/files/<folder>/<user id>/<file>?exp=..&sig=..
// Serves an uploaded file from local disk (see lib/fileStore.js). No login is
// needed: like the Azure SAS links it replaces, the signature in the link is
// the permission, so the same link works in <img> tags and download buttons.

const fs = require('fs');
const path = require('path');
const express = require('express');
const fileStore = require('../lib/fileStore');

const router = express.Router();

// Shown in the browser; everything else downloads, so an uploaded .html or
// .svg can never run as a page on our site.
const INLINE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
};

router.get('/:folder/:owner/:file', (req, res) => {
  if (!fileStore.enabled()) return res.status(404).json({ error: 'Not found' });
  const { folder, owner, file } = req.params;
  const fileKey = `${folder}/${owner}/${file}`;
  const full = fileStore.resolve(fileKey);
  if (!full) return res.status(400).json({ error: 'Invalid file path' });
  if (!fileStore.verify(fileKey, req.query.exp, req.query.sig)) {
    return res.status(403).json({ error: 'This file link is invalid or has expired' });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(file).toLowerCase();
  const inlineType = INLINE_TYPES[ext];
  // The stored name is "<uuid>-<safe name>"; offer the safe name on download.
  const downloadName = file.replace(/^[0-9a-f-]{36}-/, '');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Type', inlineType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inlineType ? 'inline' : 'attachment'}; filename="${downloadName}"`);
  return res.sendFile(full, { headers: {}, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
  });
});

module.exports = router;
