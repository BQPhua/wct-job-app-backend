'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { requireCandidateAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const applicationsRoutes = require('./routes/applications');
const onboardingRoutes = require('./routes/onboarding');
const exitInterviewRoutes = require('./routes/exitInterview');
const adminRoutes = require('./routes/admin');
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

// ---- Candidate auth (public) ----
app.use('/api/auth', authRoutes);

// ---- Candidate blacklist check (spec §1.1 rpc_check_blacklist) ----
// Mounted directly at the app level rather than under /api/applications
// since it isn't scoped to a specific application id.
app.get('/api/blacklist-check', requireCandidateAuth, applicationsRoutes.blacklistCheck);

// ---- Candidate-facing routes ----
app.use('/api/applications', applicationsRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/exit-interviews', exitInterviewRoutes);
app.use('/api/uploads', uploadsRoutes);

// ---- Admin routes ----
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
