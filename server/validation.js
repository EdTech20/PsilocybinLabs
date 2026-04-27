// Server-side validation of the subscription submission.
//
// This is a defense-in-depth layer: the frontend already prevents most of
// these, but securities filings must never ship incomplete or internally
// inconsistent data. Rules reflect NI 45-106 (Accredited Investor / Family,
// Friends & Business Associates) and Regulation D Rule 506(b) requirements.

const CANADIAN_JURISDICTIONS = [
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
  'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island',
  'Quebec', 'Saskatchewan', 'Yukon',
];

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function validateSubmission(p) {
  const errors = [];
  const req = (field, label) => {
    if (!p[field] || String(p[field]).trim() === '') errors.push(`${label} is required.`);
  };

  req('subscriberName', 'Full legal name');
  req('subscriberEmail', 'Email');
  req('subscriberPhone', 'Telephone');
  req('subscriberAddressLine1', 'Street address');
  req('subscriberCity', 'City');
  req('subscriberCountry', 'Country');
  req('subscriberPostal', 'Postal / ZIP code');
  req('numberOfShares', 'Number of shares');
  req('jurisdictionOfResidence', 'Jurisdiction of residence');
  req('entityType', 'Subscriber type (individual/entity)');
  req('registrantStatus', 'Registrant status');
  req('currentHoldings', 'Current share holdings');

  if (p.subscriberEmail && !isEmail(p.subscriberEmail)) {
    errors.push('Email address is not in a valid format.');
  }

  const shares = Number(p.numberOfShares);
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isInteger(shares)) {
    errors.push('Number of shares must be a positive integer.');
  }

  if (p.entityType === 'entity') {
    req('officialCapacity', 'Official capacity / title');
    req('signatoryName', 'Authorized signatory name');
  }

  // Exemption selection — the Subscriber MUST qualify under at least one
  // prospectus exemption before the Company can accept the subscription.
  const exemption = p.exemptionCategory;
  if (!exemption) {
    errors.push('Select a prospectus exemption (Accredited Investor, FFBA, or US Accredited).');
  } else {
    if (exemption === 'accredited_investor_ca') {
      if (!Array.isArray(p.aiCategories) || p.aiCategories.length === 0) {
        errors.push('Select at least one Accredited Investor category (Schedule A).');
      }
      // Individual AI → Form 45-106F9 risk acknowledgement required
      const individualAiTriggers = ['j', 'j1', 'k', 'l'];
      if (p.entityType === 'individual' && Array.isArray(p.aiCategories) &&
          p.aiCategories.some((c) => individualAiTriggers.includes(c)) &&
          !p.form45106F9Acknowledged) {
        errors.push('Form 45-106F9 risk acknowledgement must be completed for individual AI categories (j), (j.1), (k) or (l).');
      }
    }
    if (exemption === 'ffba_ca') {
      const onlyCanadianNonOntario = p.jurisdictionOfResidence &&
        CANADIAN_JURISDICTIONS.includes(p.jurisdictionOfResidence) &&
        p.jurisdictionOfResidence !== 'Ontario';
      if (!onlyCanadianNonOntario) {
        errors.push('Family, Friends & Business Associates exemption is not available in Ontario or outside Canada.');
      }
      if (!p.ffbaCategory) {
        errors.push('Select an FFBA relationship category (Schedule B).');
      }
      if (!p.ffbaRelationshipName) {
        errors.push('Provide the name of the director/officer/control person/founder you are related to.');
      }
    }
    if (exemption === 'us_accredited') {
      if (!Array.isArray(p.usAiCategories) || p.usAiCategories.length === 0) {
        errors.push('Select at least one U.S. Accredited Investor category (Schedule C, Rule 501(a)).');
      }
    }
  }

  if (!p.certifications || !p.certifications.notProceedsOfCrime) {
    errors.push('You must certify that subscription funds are not proceeds of crime.');
  }
  if (!p.certifications || !p.certifications.readAndUnderstood) {
    errors.push('You must confirm you have read and understood the agreement.');
  }
  if (!p.certifications || !p.certifications.consentToElectronicDelivery) {
    errors.push('Consent to electronic delivery and execution is required.');
  }

  return errors;
}

module.exports = { validateSubmission, CANADIAN_JURISDICTIONS };
