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
const multer = require('multer');
const upload = multer({ dest: path.join(__dirname, 'temp_uploads') });
if (!fs.existsSync(path.join(__dirname, 'temp_uploads'))) fs.mkdirSync(path.join(__dirname, 'temp_uploads'));

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

// Per-deal DocuSign signature request
app.post('/api/deals/:slug/docusign', async (req, res) => {
  console.log(`[DocuSign] Received signature request for deal: ${req.params.slug}`);
  try {
    const { docxBase64, docxFilename, subscriberName, subscriberEmail } = req.body;
    
    if (!subscriberEmail) {
      console.error('[DocuSign] Missing subscriber email');
      return res.status(400).json({ error: 'Subscriber email is required.' });
    }

    if (!isDocusignConfigured()) {
      console.error('[DocuSign] System not configured. Check .env variables.');
      return res.status(400).json({ error: 'DocuSign is not configured on this server.' });
    }

    console.log(`[DocuSign] Initiating envelope for ${subscriberName} <${subscriberEmail}>`);
    const result = await sendForSignature({
      documentBuffer: Buffer.from(docxBase64, 'base64'),
      documentName: docxFilename,
      subscriberName,
      subscriberEmail,
      issuerSignerName: process.env.ISSUER_SIGNER_NAME,
      issuerSignerEmail: process.env.ISSUER_SIGNER_EMAIL
    });

    console.log('[DocuSign] Envelope created successfully:', result.envelopeId);
    res.json(result);
  } catch (err) {
    console.error('[DocuSign] Error detailed:', err);
    res.status(500).json({ 
      error: err.message || 'Failed to send for signature',
      details: err.response ? err.response.body : null 
    });
  }
});

// Create a new deal (Admin)
app.post('/api/admin/deals', upload.single('template'), (req, res) => {
  try {
    const { displayName, slug, issuer, unitPrice, currency, notifyEmail, unitName, unitNamePlural, fromEmail, wireInstructions } = req.body;
    
    if (!displayName || !issuer) return res.status(400).json({ error: 'Display name and issuer are required' });

    // Generate slug if not provided
    const baseSlug = slug || displayName;
    const targetSlug = baseSlug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    
    const dealPath = path.join(DEALS_DIR, targetSlug);
    if (fs.existsSync(dealPath)) {
      return res.status(400).json({ error: `Deal with slug "${targetSlug}" already exists.` });
    }

    fs.mkdirSync(dealPath, { recursive: true });
    fs.mkdirSync(path.join(dealPath, 'filings'), { recursive: true });

    if (req.file) {
      fs.renameSync(req.file.path, path.join(dealPath, 'template.docx'));
    }

    const config = {
      displayName,
      issuer,
      unitPrice: Number(unitPrice) || 0.5,
      currency: currency || 'CAD',
      notifyEmail: notifyEmail || '',
      unitName: unitName || 'share',
      unitNamePlural: unitNamePlural || 'shares',
      fromEmail: fromEmail || '',
      wireInstructions: wireInstructions || '',
      createdAt: new Date().toISOString().split('T')[0]
    };

    fs.writeFileSync(path.join(dealPath, 'deal.json'), JSON.stringify(config, null, 2));

    res.json({ ok: true, slug: targetSlug, url: `/d/${targetSlug}` });
  } catch (err) {
    console.error('Admin create error:', err);
    res.status(500).json({ error: 'Failed to create deal folder' });
  }
});

// ---- Page routes ----

// Serve the self-contained portal as the primary home route
app.get('/', (req, res) => {
  const portalPath = path.join(ROOT, 'public', 'portal.html');
  if (fs.existsSync(portalPath)) return res.sendFile(portalPath);
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// /portal also serves the portal
app.get('/portal', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'portal.html'));
});

// Serve the portal for any /d/:slug path (slug is passed to the page via URL)
app.get('/d/:slug', (req, res) => {
  const config = getDealConfig(req.params.slug);
  if (!config) return res.status(404).send('Deal not found');
  const portalPath = path.join(ROOT, 'public', 'portal.html');
  if (fs.existsSync(portalPath)) return res.sendFile(portalPath);
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// Legacy routes
app.get('/landing', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'landing.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin.html'));
});
app.get('/success', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'success.html'));
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

