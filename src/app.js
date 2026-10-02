'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { requireCandidateAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const applicationsRoutes = require('./routes/applications');
const onboardingRoutes = require('./routes/onboarding');
const adminRoutes = require('./routes/admin');
const adminOffboardingRoutes = require('./routes/adminOffboarding');
const offboardingRoutes = require('./routes/offboarding');
const offboardingCronRoutes = require('./routes/offboardingCron');
const aiInsightsRoutes = require('./routes/aiInsights');
const uploadsRoutes = require('./routes/uploads');

const app = express();

app.use(cors());

// The AI document-analysis mode (spec §8.4, 'document' mode in
// routes/aiInsights.js) sends full base64-encoded file content in the
// request body — raise the JSON body limit to accommodate that. Every other
// route in this app deals with ordinary form-sized JSON, so this is a
// deliberately generous ceiling rather than a per-route tuning.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Live screen updates (see lib/liveEvents.js) ----
// Watches every request; after a successful change it pings open admin screens.
const liveEvents = require('./lib/liveEvents');
const { requireAdminAuth } = require('./middleware/auth');
app.use(liveEvents.trackChanges);
app.get('/api/admin/events', requireAdminAuth, liveEvents.stream);

// ---- Candidate auth (public) ----
app.use('/api/auth', authRoutes);

// ---- Candidate blacklist check (spec §1.1 rpc_check_blacklist) ----
// Mounted directly at the app level rather than under /api/applications
// since it isn't scoped to a specific application id.
app.get('/api/blacklist-check', requireCandidateAuth, applicationsRoutes.blacklistCheck);

// ---- Candidate-facing routes ----
app.use('/api/applications', applicationsRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/uploads', uploadsRoutes);
// Signed links to uploaded files on local disk (own server; see lib/fileStore).
app.use('/api/files', require('./routes/files'));
// Offboarding: the daily reminder endpoint (secret-key protected, called by
// Power Automate) must be mounted before the candidate-auth router.
app.use('/api/offboarding/cron', offboardingCronRoutes);
app.use('/api/offboarding', offboardingRoutes);

// ---- Admin routes ----
// Offboarding is mounted BEFORE the general admin router: that router gates
// everything after /me to HR admins, while offboarding is also used by
// Payroll PICs, Clearance PICs and immediate superiors.
app.use('/api/admin/offboarding', adminOffboardingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/ai-insights', aiInsightsRoutes);

// ---- 404 fallback ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---- Central error handler ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
