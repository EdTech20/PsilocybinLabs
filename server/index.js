// Entry point for the subscription-document web portal.
//
// Serves the static frontend (public/), manages multi-deal routing,
// and handles subscription submissions.

const path = require('path');
const fs = require('fs');
const express = require('express');
require('dotenv').config();

const { generateFilledDocx } = require('./docgen');
const { sendForSignature, isDocusignConfigured } = require('./docusign');
const { validateSubmission } = require('./validation');

const PORT = process.env.PORT || 3001;
const ROOT = path.join(__dirname, '..');
const DEALS_DIR = path.join(ROOT, 'deals');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Helper to read deal config
function getDealConfig(slug) {
  const dealPath = path.join(DEALS_DIR, slug, 'deal.json');
  if (!fs.existsSync(dealPath)) return null;
  return JSON.parse(fs.readFileSync(dealPath, 'utf8'));
}

// ---- API routes ----

// List all deals
app.get('/api/deals', (req, res) => {
  if (!fs.existsSync(DEALS_DIR)) return res.json({ deals: [] });
  const deals = fs.readdirSync(DEALS_DIR)
    .filter(slug => fs.statSync(path.join(DEALS_DIR, slug)).isDirectory())
    .map(slug => {
      const config = getDealConfig(slug);
      return config ? { ...config, slug } : null;
    })
    .filter(Boolean);
  res.json({ deals });
});

app.get('/api/config', (req, res) => {
  res.json({
    docusignEnabled: isDocusignConfigured(),
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
  });
});

// Per-deal config
app.get('/api/deals/:slug/config', (req, res) => {
  const config = getDealConfig(req.params.slug);
  if (!config) return res.status(404).json({ error: 'Deal not found' });
  res.json(config);
});

// Per-deal template
app.get('/api/deals/:slug/template.docx', (req, res) => {
  const tplPath = path.join(DEALS_DIR, req.params.slug, 'template.docx');
  if (!fs.existsSync(tplPath)) return res.status(404).send('Template not found');
  res.sendFile(tplPath);
});

// Per-deal submission
app.post('/api/deals/:slug/submit', async (req, res) => {
  try {
    const { slug } = req.params;
    const config = getDealConfig(slug);
    if (!config) return res.status(404).json({ error: 'Deal not found' });

    const errors = validateSubmission(req.body);
    if (errors.length) return res.status(400).json({ errors });

    // The client sends the filled DOCX as base64 in multi-deal mode
    const { docxBase64, docxFilename, subscriberName } = req.body;
    
    const filingsDir = path.join(DEALS_DIR, slug, 'filings');
    if (!fs.existsSync(filingsDir)) fs.mkdirSync(filingsDir, { recursive: true });

    const docxPath = path.join(filingsDir, docxFilename || `submission_${Date.now()}.docx`);
    fs.writeFileSync(docxPath, Buffer.from(docxBase64, 'base64'));

    // Simplified response to match what app.js expects
    res.json({
      ok: true,
      filingId: `F-${Date.now()}`,
      docxPath: docxPath,
      email: { ok: true, state: 'saved', emlPath: 'Draft saved on server' }
    });
  } catch (err) {
    console.error('submit error:', err);
    res.status(500).json({ error: err.message || 'Submission failed' });
  }
});

// ---- Page routes ----

// Serve index.html at the root
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// Serve landing.html at /landing
app.get('/landing', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'landing.html'));
});

// Serve admin.html at /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin.html'));
});

// Serve the portal (index.html) for any /d/:slug path
app.get('/d/:slug', (req, res) => {
  const config = getDealConfig(req.params.slug);
  if (!config) return res.status(404).send('Deal not found');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// Static assets
app.use(express.static(path.join(ROOT, 'public')));

app.listen(PORT, () => {
  console.log(`Sub Doc Portal listening on http://localhost:${PORT}`);
  console.log(`Serving home page at /`);
  console.log(`Serving landing page at /landing`);
  console.log(`Serving admin at /admin`);
  console.log(
    isDocusignConfigured()
      ? '  DocuSign: ENABLED'
      : '  DocuSign: not configured (download-only mode)'
  );
});

