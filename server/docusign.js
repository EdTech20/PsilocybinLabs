// Thin wrapper around the DocuSign eSignature REST API (JWT grant).
//
// Required env vars (see .env.example):
//   DOCUSIGN_INTEGRATION_KEY      Integration key (client ID) from DocuSign Admin
//   DOCUSIGN_USER_ID              API Username (GUID) of the impersonated user
//   DOCUSIGN_ACCOUNT_ID           API Account ID
//   DOCUSIGN_PRIVATE_KEY          RSA private key (contents, not path) — paired
//                                 with the public key uploaded to the DocuSign app
//   DOCUSIGN_AUTH_SERVER          "account-d.docusign.com" (demo) or
//                                 "account.docusign.com" (production)
//   DOCUSIGN_BASE_PATH            "https://demo.docusign.net/restapi" (demo) or
//                                 production equivalent
//   ISSUER_SIGNER_NAME / EMAIL    Name & email of the authorized signatory for
//                                 1210954 B.C. Ltd. who countersigns.
//
// Anchor-tab strategy: DocuSign places signer tabs on anchor strings that
// already exist in the generated document (e.g. "Signature of Subscriber").
// This keeps the template legally faithful — no visual changes required.

const docusign = require('docusign-esign');

function isDocusignConfigured() {
  return Boolean(
    process.env.DOCUSIGN_INTEGRATION_KEY &&
      process.env.DOCUSIGN_USER_ID &&
      process.env.DOCUSIGN_ACCOUNT_ID &&
      process.env.DOCUSIGN_PRIVATE_KEY &&
      process.env.ISSUER_SIGNER_EMAIL
  );
}

async function getAccessToken() {
  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath(process.env.DOCUSIGN_AUTH_SERVER || 'account-d.docusign.com');

  const privateKey = Buffer.from(process.env.DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, '\n'));

  const results = await apiClient.requestJWTUserToken(
    process.env.DOCUSIGN_INTEGRATION_KEY,
    process.env.DOCUSIGN_USER_ID,
    ['signature', 'impersonation'],
    privateKey,
    3600
  );
  return results.body.access_token;
}

function buildEnvelope({ documentBuffer, documentName, subscriberName, subscriberEmail, issuerSignerName, issuerSignerEmail }) {
  const doc = docusign.Document.constructFromObject({
    documentBase64: Buffer.from(documentBuffer).toString('base64'),
    name: documentName,
    fileExtension: 'docx',
    documentId: '1',
  });

  // Anchor-based tabs so we don't have to hardcode page/x/y coordinates.
  const subscriberSignTab = docusign.SignHere.constructFromObject({
    anchorString: 'Signature of Subscriber or Authorized Representative',
    anchorUnits: 'pixels',
    anchorYOffset: '-8',
    anchorXOffset: '0',
  });
  const subscriberDateTab = docusign.DateSigned.constructFromObject({
    anchorString: 'Signature of Subscriber or Authorized Representative',
    anchorUnits: 'pixels',
    anchorYOffset: '-8',
    anchorXOffset: '260',
  });

  // Form 45-106F9 risk acknowledgement rows: place subscriber initials in the
  // "Your initials" column so the recipient can complete the risk form inside
  // DocuSign even when the generated DOCX is sent with blank boxes.
  const subscriberInitialTabs = [
    // Form 45-106F9 section 2
    'Risk of loss',
    'Liquidity risk',
    'Lack of information',
    'Lack of advice',
    // Form 45-106F9 section 3
    'Your net income before taxes was more than $200,000',
    'Your net income before taxes combined with your spouse’s was more than $300,000',
    'Either alone or with your spouse, you own more than $1 million in cash and securities',
    'Either alone or with your spouse, you may have net assets worth more than $5 million',
  ].map((anchorString, index) =>
    docusign.Text.constructFromObject({
      anchorString,
      anchorUnits: 'pixels',
      anchorYOffset: '10',
      anchorXOffset: '560',
      width: '72',
      height: '28',
      font: 'helvetica',
      fontSize: 'size10',
      bold: 'true',
      required: 'true',
      maxLength: '4',
      tabLabel: `subscriber_initials_${index + 1}`,
      tooltip: 'Enter your initials',
      anchorIgnoreIfNotPresent: 'true',
      disableAutoSize: 'true',
    })
  );

  const scheduleASignTab = docusign.SignHere.constructFromObject({
    anchorString: 'Print the name of Subscriber',
    anchorUnits: 'pixels',
    anchorYOffset: '-60',
    anchorXOffset: '0',
    optional: 'true',
  });

  const issuerSignTab = docusign.SignHere.constructFromObject({
    anchorString: 'Authorized Signatory',
    anchorUnits: 'pixels',
    anchorYOffset: '-30',
    anchorXOffset: '0',
  });

  const subscriber = docusign.Signer.constructFromObject({
    email: subscriberEmail,
    name: subscriberName,
    recipientId: '1',
    routingOrder: '1',
    tabs: docusign.Tabs.constructFromObject({
      signHereTabs: [subscriberSignTab, scheduleASignTab],
      dateSignedTabs: [subscriberDateTab],
      textTabs: subscriberInitialTabs,
    }),
  });

  const issuer = docusign.Signer.constructFromObject({
    email: issuerSignerEmail,
    name: issuerSignerName || 'Authorized Signatory, 1210954 B.C. Ltd.',
    recipientId: '2',
    routingOrder: '2',
    tabs: docusign.Tabs.constructFromObject({
      signHereTabs: [issuerSignTab],
    }),
  });

  return docusign.EnvelopeDefinition.constructFromObject({
    emailSubject: 'PsilocybinLabs — Subscription Agreement for execution',
    emailBlurb:
      'Please review and execute the attached private placement subscription agreement. ' +
      'Note: securities offered are subject to resale restrictions under applicable Canadian ' +
      'securities laws (see the agreement for details).',
    documents: [doc],
    recipients: docusign.Recipients.constructFromObject({ signers: [subscriber, issuer] }),
    status: 'sent',
  });
}

async function sendForSignature(args) {
  const accessToken = await getAccessToken();

  const apiClient = new docusign.ApiClient();
  apiClient.setBasePath(process.env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi');
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + accessToken);

  const envelopesApi = new docusign.EnvelopesApi(apiClient);
  const envelope = buildEnvelope(args);

  const result = await envelopesApi.createEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, {
    envelopeDefinition: envelope,
  });

  return { envelopeId: result.envelopeId, status: result.status };
}

module.exports = { sendForSignature, isDocusignConfigured };
