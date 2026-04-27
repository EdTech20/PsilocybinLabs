# PsilocybinLabs — Subscription Document Portal

A web portal that collects subscriber information via a guided multi-step form,
auto-fills the 1210954 B.C. Ltd. (PsilocybinLabs) private placement subscription
agreement, and — when configured — routes the completed document through
DocuSign for e-signature.

The portal is designed around the **original, lawyer-drafted agreement**
(`sample_agreement.docx`). The form's structure, exemption options, and
validation rules mirror the requirements of:

- **NI 45-106** — Prospectus Exemptions (accredited investor + family, friends
  and business associates) including Form 45-106F9 risk acknowledgement.
- **Section 73.3 Securities Act (Ontario)** — Ontario-specific AI categories.
- **Regulation D Rule 506(b)** — U.S. accredited investor status (Schedule C).
- **Saskatchewan Schedule B1** — risk acknowledgement for close personal
  friends / close business associates in Saskatchewan.

## Project layout

```
.
├── sample_agreement.docx        Original agreement (reference; do not modify).
├── scripts/
│   ├── build-template.ps1       Injects {placeholders} into the agreement XML
│   │                             and writes templates/template.docx.
│   └── serve.ps1                PowerShell dev server: static frontend +
│                                 POST /api/submit (save + Excel + Outlook email).
├── templates/template.docx      docxtemplater template (generated).
├── server/                      (Optional) Node.js + DocuSign backend.
├── public/
│   ├── index.html               Multi-step wizard.
│   ├── styles.css
│   ├── app.js                   Client logic, client-side DOCX merge.
│   └── template-data.js         Base64-embedded template (generated).
├── generated/
│   ├── filings/                 Filed DOCX per submission.
│   ├── subscriptions.csv        Source-of-truth ledger (append-only).
│   └── subscriptions.xlsx       Regenerated from CSV after each submit.
├── .env.example                 Template for DocuSign / issuer credentials.
└── package.json
```

## Two ways to run

### PowerShell (no install — recommended for local filing workflow)

`scripts/serve.ps1` is a self-contained static server with a built-in
submission endpoint. When a subscriber clicks **Submit & file**:

1. The filled DOCX is saved to
   `generated/filings/PsilocybinLabs_SubAgreement_<Name>_<YYYYMMDD-HHMMSS>.docx`.
2. A row is appended to `generated/subscriptions.csv` (source of truth;
   one row per subscriber covering identity, address, jurisdiction, shares,
   aggregate, exemption + categories, execution date, and file path).
3. `generated/subscriptions.xlsx` is regenerated from the CSV (bolded header,
   single worksheet named **Subscriptions**).
4. A ready-to-send email draft (`.eml`) is written next to the DOCX, with the
   DOCX + Excel log embedded as attachments and the recipient/subject/body
   pre-populated. By default the server fires `Start-Process` on the `.eml`
   so the default mail client (Outlook, Thunderbird, etc.) opens with the
   draft ready for a human to click **Send**.

Start with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/serve.ps1 -Port 3000
# → http://localhost:3000
```

Flags:

- `-NotifyEmail someone@firm.com` — destination address (default `Olivia@northwardcap.com`)
- `-FromEmail portal@firm.com`    — From header in the draft
- `-NoAutoOpen`                   — just write the `.eml` file (don't pop Outlook). Useful while iterating on the portal; the file path is returned in the submission response so the user can open it manually.

### Upgrading to true silent send

The `.eml` flow requires a human to click Send. If you want fully automated
delivery:

- **SMTP** — add `Send-MailMessage` (or `System.Net.Mail.SmtpClient`) to the
  `Queue-Email` function with a service account. Office 365: host
  `smtp.office365.com`, port `587`, STARTTLS, app-password auth.
- **Microsoft Graph / Exchange Online** — register an app in Entra ID with
  `Mail.Send` application permission and call the `/sendMail` endpoint.
- **Outlook COM silent** — enable programmatic access in Outlook Trust Center
  (*File → Options → Trust Center → Programmatic Access → Never warn*), then
  swap `$mail.Display($false)` for `$mail.Send()` in a Queue-Email that uses
  the COM API. Note: corporate policy often blocks this.

### Node.js (optional — adds real DocuSign JWT flow)

The `server/` folder contains an Express app with `docusign-esign` wired up for
JWT grant auth. Install Node 18+, `npm install`, populate `.env` per
`.env.example`, then `npm start`. See the "DocuSign setup" section below.

## Running locally

Prerequisites: **Node.js 18+** and **PowerShell 5+** (the template preprocessor
uses `System.IO.Compression` — available on Windows and PowerShell 7 on any OS).

```powershell
# 1. Install deps
npm install

# 2. Build the DOCX template from the original agreement
npm run build-template

# 3. Copy .env.example → .env and configure issuer signer
# (Leave DOCUSIGN_* blank for download-only mode.)

# 4. Start the portal
npm start
# → http://localhost:3000
```

If you don't yet have Node installed: download LTS from
<https://nodejs.org> and rerun step 1.

## DocuSign setup (JWT grant)

1. Create a free **Developer account** at <https://developers.docusign.com>.
2. In *Settings → Apps and Keys*, create an **Integration Key**.
3. Enable **JWT Grant**. Upload a public RSA key and keep the private key.
4. Grant consent once (visit the consent URL shown by the SDK on first run).
5. Fill the DocuSign section of `.env`:
   - `DOCUSIGN_INTEGRATION_KEY` — client ID
   - `DOCUSIGN_USER_ID` — API user GUID (the impersonated user)
   - `DOCUSIGN_ACCOUNT_ID` — API account ID
   - `DOCUSIGN_PRIVATE_KEY` — full PEM contents on one line, `\n` between lines
   - `DOCUSIGN_AUTH_SERVER` — `account-d.docusign.com` (demo) or
     `account.docusign.com` (production)
   - `DOCUSIGN_BASE_PATH` — `https://demo.docusign.net/restapi` (demo) or the
     production base path shown in the DocuSign admin UI.
6. Set `ISSUER_SIGNER_NAME` / `ISSUER_SIGNER_EMAIL` to the authorized signatory
   at 1210954 B.C. Ltd.

### Signer routing

The envelope is configured with **two signers, sequential**:

1. **Subscriber** — name & email from the form. Signature tabs are placed by
   **anchor strings** ("Signature of Subscriber or Authorized Representative",
   "Print the name of Subscriber") so no x/y coordinates need tuning.
2. **Issuer** — from the `.env` values. Signs "Authorized Signatory" on the
   face-page Acceptance block after the subscriber completes.

## Compliance notes

- **This portal is a workflow tool, not legal advice.** The executed agreement
  is still subject to acceptance by the Company's board and to all regulatory
  approvals.
- The server keeps an **audit copy** of every envelope in `/generated` — keep
  those files for at least 7 years (CRA + BCSC recordkeeping guidance).
- Before going live, have the issuer's counsel:
  1. Re-review the templated `templates/template.docx` to confirm the injected
     placeholders have not altered any operative text.
  2. Confirm the DocuSign anchor-tab positions place signatures, dates, and
     initials correctly.
  3. Verify the exemption matrix (residence × exemption) matches the issuer's
     distribution plan — particularly for offerees outside Canada.
- Subscription funds are received by McMillan LLP, In Trust, per the wire
  instructions page of the agreement. The portal does **not** collect funds;
  it only produces the paperwork.

## Extending the portal

- **Additional offerings.** Drop another templated DOCX into `/templates` and
  parameterize the template path in `server/docgen.js`.
- **KYC integration.** Add a step between 3 and 4 that calls a KYC provider
  (Persona, Onfido, etc.); gate submission on a verified result.
- **Portal co-branding.** Edit `public/styles.css` — the brand accent is
  `--accent` and the brand mark is the two-letter badge in the header.
