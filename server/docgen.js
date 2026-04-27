// Merges the structured submission payload into the docxtemplater-style
// template at templates/template.docx. Returns the filled DOCX as a Buffer.

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'template.docx');

function sanitize(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function formatMoney(amount) {
  if (amount === undefined || amount === null || amount === '') return '';
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
}

function buildPlaceholders(payload) {
  const shares = Number(payload.numberOfShares) || 0;
  const price = shares * 0.5; // $0.50/share offering — per face page of agreement

  const addressParts = [
    payload.subscriberAddressLine1,
    payload.subscriberAddressLine2,
    [payload.subscriberCity, payload.subscriberProvince, payload.subscriberPostal].filter(Boolean).join(', '),
    payload.subscriberCountry,
  ].filter(Boolean);

  const regParts = [
    payload.regName,
    payload.regAccountRef,
    payload.regAddress,
  ].filter(Boolean);

  return {
    SUBSCRIBER_NAME: sanitize(payload.subscriberName),
    OFFICIAL_CAPACITY: sanitize(payload.officialCapacity || (payload.entityType === 'individual' ? 'Individual' : '')),
    SIGNATORY_NAME: sanitize(payload.signatoryName || payload.subscriberName),
    SUBSCRIBER_ADDRESS: addressParts.join(', '),
    SUBSCRIBER_PHONE: sanitize(payload.subscriberPhone),
    SUBSCRIBER_EMAIL: sanitize(payload.subscriberEmail),
    NUMBER_OF_SHARES: shares ? shares.toLocaleString('en-CA') : '',
    AGGREGATE_PRICE: formatMoney(price),
    SUBSCRIPTION_NO: sanitize(payload.subscriptionNo),
    DISCLOSED_PRINCIPAL_NAME: sanitize(payload.disclosedPrincipalName),
    DISCLOSED_PRINCIPAL_ADDRESS: sanitize(payload.disclosedPrincipalAddress),
    REG_NAME: regParts[0] || sanitize(payload.subscriberName),
    REG_ADDRESS: regParts.slice(1).join(', ') || addressParts.join(', '),
    JURISDICTION_OF_RESIDENCE: sanitize(payload.jurisdictionOfResidence),
    AUTH_SIGNATORY_NAME_TITLE: payload.entityType === 'individual'
      ? ''
      : `${sanitize(payload.signatoryName)}, ${sanitize(payload.officialCapacity)}`,
    EXECUTION_DATE: formatDate(payload.executionDate || new Date().toISOString()),
  };
}

async function generateFilledDocx(payload) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `Template not found at ${TEMPLATE_PATH}. Run "npm run build-template" first.`
    );
  }

  const content = fs.readFileSync(TEMPLATE_PATH);
  const zip = new PizZip(content);

  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{', end: '}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });

  doc.render(buildPlaceholders(payload));

  const buffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });

  const safeName = sanitize(payload.subscriberName || 'Subscriber')
    .replace(/[^a-z0-9-]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  const filename = `PsilocybinLabs_SubAgreement_${safeName}_${new Date()
    .toISOString()
    .slice(0, 10)}.docx`;

  return { buffer, filename };
}

module.exports = { generateFilledDocx };
