# AutoSubDoc — Handover

A Windows-only web portal that turns any subscription document into a
self-serve investor portal: one deal per uploaded `.docx`, each with its own
URL, filings folder, master spreadsheet, notification email, and Stripe
checkout. No Node.js, no Python, no Docker — just PowerShell.

> **Word version**: a polished `.docx` of this whole document is committed
> at `AutoSubDoc_Instructions.docx` in the project root. Open it in Word to
> annotate / print. After you make changes here, regenerate the Word copy
> with:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File scripts/export-instructions.ps1
> ```

---

## 1. The 60-second mental model

```
Site:      AutoSubDoc      (always at /)
URL        Page                       What it does
─────      ────────────────────────   ────────────────────────────────
/          Landing                    Lists every offering
/admin     Admin                      Upload a new offering's .docx
/d/<slug>  Deal portal                Investor-facing subscription form
                                       (named after the offering)
```

Each offering ("deal") is a folder under `deals/<slug>/`:

```
deals/<slug>/
├── deal.json          metadata (name, issuer, currency, price, email, etc.)
├── template.docx      the subscription document with {PLACEHOLDERS}
├── subscriptions.csv  master ledger (append-only)
├── subscriptions.xlsx regenerated from the CSV after each filing
└── filings/
    ├── <slug>_SubAgreement_<Name>_<timestamp>.docx
    └── <filingId>.eml  pre-populated email draft
```

When an investor clicks **Submit & file**:

1. The browser merges its inputs into `template.docx` client-side.
2. The merged DOCX is POSTed to `/api/deals/<slug>/submit` and saved into
   `deals/<slug>/filings/`.
3. A row is appended to that deal's `subscriptions.csv`.
4. `subscriptions.xlsx` is regenerated from the CSV (bold header, one tab,
   sortable).
5. An `.eml` email draft is written next to the DOCX with both files
   attached, addressed to that deal's `notifyEmail`. The default mail
   client (Outlook / Thunderbird / etc.) opens with everything pre-filled.
6. (Optional) The investor pays the aggregate price via Stripe Checkout.

---

## 2. Run it

```powershell
powershell -ExecutionPolicy Bypass -File scripts/serve.ps1 -Port 3000
```

Open http://localhost:3000.

| Flag                  | Default                  | Use                                               |
|-----------------------|--------------------------|---------------------------------------------------|
| `-Port 3000`          | 3000                     | Listening port                                    |
| `-NoAutoOpen`         | off                      | Save `.eml` but don't auto-launch Outlook         |
| `-StripeSecretKey X`  | `$env:STRIPE_SECRET_KEY` | Stripe key — `sk_test_…` for sandbox              |
| `-PortalUrl X`        | `http://localhost:3000`  | Public base URL used in Stripe success/cancel URLs |

**Stop the server** with Ctrl+C. If port 3000 stays bound after a crash:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 3. Adding a new deal (the most important task)

There are **two ways**: the web admin (recommended) or by hand. Either way
the only artifact you really need is a `template.docx` that has been
marked-up with `{PLACEHOLDERS}`.

### 3.1 Prepare `template.docx`

1. Open the issuer's subscription document in Word.
2. Find every blank where investor info goes and replace it with a
   placeholder in curly braces. The portal recognises these names by
   default:

   | Placeholder              | Filled with                                              |
   |--------------------------|----------------------------------------------------------|
   | `{SUBSCRIBER_NAME}`      | Full legal name (face page + Schedule A signature block) |
   | `{OFFICIAL_CAPACITY}`    | "Individual" / "Director" / etc.                         |
   | `{SIGNATORY_NAME}`       | Authorized signatory if entity                           |
   | `{SUBSCRIBER_ADDRESS}`   | Comma-joined full address                                |
   | `{SUBSCRIBER_PHONE}`     | Telephone                                                |
   | `{SUBSCRIBER_EMAIL}`     | Email                                                    |
   | `{NUMBER_OF_SHARES}`     | Quantity (works for any unit type)                       |
   | `{AGGREGATE_PRICE}`      | Quantity × `unitPrice`, formatted with deal's currency   |
   | `{JURISDICTION_OF_RESIDENCE}` | Province/state for securities-law purposes          |
   | `{EXECUTION_DATE}`       | Subscriber's typed date                                  |
   | `{REGISTERED_CHECK}` / `{NOT_REGISTERED_CHECK}` | `[X]` / `[ ]` (face page registrant status) |

   *PsilocybinLabs uses ~85 placeholders covering every NI 45-106 AI
   category, Form 45-106F9 risk acknowledgement, Schedule B FFBA, Schedule
   C US-AI categories, etc. Most deals only need ~12 placeholders. See
   `scripts/build-template.ps1` for the exhaustive list.*

3. Save the file.

### 3.2 Upload via /admin (recommended)

1. Open http://localhost:3000/admin.
2. Fill in:
   - **Display name** — appears as the page title (e.g. "Acme Bio — Series
     A Preferred")
   - **Slug** — leave blank to auto-derive from the display name. Becomes
     the URL: `/d/<slug>/`
   - **Issuer** — legal name of the issuing company
   - **Currency** — CAD / USD / EUR / GBP
   - **Price per unit** — e.g. `2.50`
   - **Unit name** — `common share`, `preferred share`, `convertible note`,
     etc.
   - **Notification email** — where the filed paperwork is emailed
   - **From email** — the From: header on the .eml drafts
   - **Wire instructions** — pasted verbatim into the "Wire instructions"
     dialog the subscriber sees after filing
   - **Subscription document** — the marked-up `template.docx`
3. Click **Create deal**. The deal becomes live at `/d/<slug>/` and shows
   on the landing page.

### 3.3 Upload by hand

For when admins prefer the file system:

```powershell
$slug = 'acme-bio-seriesa'
New-Item -ItemType Directory -Force -Path "deals\$slug\filings"
Copy-Item path\to\prepared-template.docx "deals\$slug\template.docx"

@'
{
  "slug": "acme-bio-seriesa",
  "displayName": "Acme Bio - Series A Preferred",
  "issuer": "Acme Bio Inc.",
  "subTitle": "Private Placement Subscription Portal",
  "currency": "USD",
  "unitPrice": 2.50,
  "unitName": "preferred share",
  "unitNamePlural": "preferred shares",
  "formType": "simple",
  "notifyEmail": "legal@acmebio.com",
  "fromEmail": "subscriptions@acmebio.com",
  "stripeEnabled": true,
  "wireInstructions": "Acme Bio - SVB Account 12345-67890\nABA: 121140399\nReference: Series A Subscription",
  "createdAt": "2026-04-25"
}
'@ | Set-Content "deals\$slug\deal.json" -Encoding UTF8
```

The new deal is picked up immediately — no server restart needed.

---

## 4. File map

```
.
├── INSTRUCTIONS.md                 ← you are here
├── README.md                       ← shorter setup doc
├── deals/                          ← one folder per offering
│   └── psilocybinlabs/             ← reference deal (full Canadian PP)
│       ├── deal.json
│       ├── template.docx
│       ├── source.docx             (original unmodified agreement)
│       └── filings/
├── scripts/
│   ├── serve.ps1                   ← the entire web server + APIs
│   └── build-template.ps1          ← (legacy) builds PsilocybinLabs template
│                                       from sample_agreement.docx
├── public/                         ← shared frontend
│   ├── landing.html                ← AutoSubDoc home (deal directory)
│   ├── admin.html                  ← upload-a-new-deal form
│   ├── index.html                  ← per-deal subscription form
│   ├── styles.css
│   └── app.js                      ← deal-aware client logic
└── sample_agreement.docx           ← source of the PsilocybinLabs template
```

The legacy Node.js scaffolding under `server/` is no longer used by the
running portal. Ignore it unless someone resurrects DocuSign.

---

## 5. The HTTP API (reference)

| Method | Path                                              | Use                                                      |
|-------:|---------------------------------------------------|----------------------------------------------------------|
|   GET  | `/api/deals`                                      | List all deals                                           |
|   GET  | `/api/deals/<slug>/config`                        | Single deal's `deal.json`                                |
|   GET  | `/api/deals/<slug>/template.docx`                 | Raw template file                                        |
|  POST  | `/api/deals/<slug>/submit`                        | File a subscription (JSON: form data + base64 DOCX)      |
|  POST  | `/api/deals/<slug>/stripe/checkout`               | Create Stripe Checkout Session                           |
|   GET  | `/api/deals/<slug>/stripe/status?session_id&filing` | Verify payment + mark filing as paid in CSV/XLSX       |
|  POST  | `/api/admin/deals`                                | `multipart/form-data`: create new deal (metadata + .docx) |
|   GET  | `/api/config`                                     | Server-wide settings (`stripeConfigured`, `portalUrl`)   |

---

## 6. Stripe (per-deal payments)

Stripe is **off by default** — investors see the wire instructions only.
To enable card payments:

1. Create a Stripe account → switch to **Test mode** → copy the **Secret
   key** (`sk_test_…`).
2. Set the env var on the host machine:
   ```powershell
   [Environment]::SetEnvironmentVariable('STRIPE_SECRET_KEY', 'sk_test_...', 'User')
   ```
   Open a fresh PowerShell window and restart the server.
3. The startup banner now says `Stripe: ENABLED`. The "Pay with card"
   button on the success modal becomes clickable.
4. Test with card `4242 4242 4242 4242`, any future expiry, any CVC.
5. Stripe redirects back to `/d/<slug>/?paid=1&filing=<id>&session_id=cs_…`.
   The portal calls `/api/deals/<slug>/stripe/status` to re-verify with
   Stripe (don't trust the query string alone) and updates the CSV row to
   `PaymentMethod=stripe`, `PaymentStatus=paid`, `StripeSessionId=cs_…`.

**Going live:** swap to a `sk_live_…` key, set `-PortalUrl` to the
production domain, and (recommended) wire a `checkout.session.completed`
webhook to close the gap when a customer pays but closes the browser
before the redirect finishes. Webhook signature verification is the only
piece not in the codebase yet.

---

## 7. Common tasks

### "Olivia's email changed"

It's per-deal. Either edit the `notifyEmail` field in `deals/<slug>/deal.json`
and refresh the page, or rebuild the deal via /admin.

### "We changed the offering price"

Edit `deals/<slug>/deal.json` → update `unitPrice`. Existing filings keep
their original aggregate (it's stored in the CSV at submission time); new
filings use the new price. No server restart needed.

### "I need to delete a test deal"

```powershell
Remove-Item -Recurse "deals\acme-bio-seriesa"
```

The deal disappears from /, /admin, and any in-flight investor pages
404 on next request. You can also archive the CSV elsewhere first.

### "Investor pays via wire — how do I mark them paid?"

Open `deals/<slug>/subscriptions.csv` and edit the `PaymentMethod` /
`PaymentStatus` columns to `wire` / `paid`. Re-run the portal once and
the XLSX regenerates next time anyone files. Or just edit the XLSX
directly (the CSV stays the source of truth, so make sure both match if
you go that route).

### "I want to test without Outlook popping up every submission"

Start the server with `-NoAutoOpen`. The `.eml` drafts are still written
into `deals/<slug>/filings/` so you can open them by hand to verify.

---

## 8. What "AutoSubDoc" knows about each deal

Stored in `deals/<slug>/deal.json`. Populated either by /admin or by
hand-editing the file:

```jsonc
{
  "slug":            "acme-bio-seriesa",         // URL-safe; matches folder name
  "displayName":     "Acme Bio - Series A...",   // appears as page title
  "issuer":          "Acme Bio Inc.",            // shown in subtitle
  "subTitle":        "Private Placement Subscription Portal",
  "currency":        "USD",                      // CAD / USD / EUR / GBP
  "unitPrice":       2.50,                       // per unit
  "unitName":        "preferred share",          // singular
  "unitNamePlural":  "preferred shares",         // shown on form labels
  "formType":        "simple",                   // or "complex_canadian_pp"
  "notifyEmail":     "legal@acmebio.com",        // To: header on .eml
  "fromEmail":       "subscriptions@acmebio.com",// From: header on .eml
  "stripeEnabled":   true,                       // controls "Pay with card" button
  "wireInstructions":"Bank... Account... Reference...",
  "createdAt":       "2026-04-25"
}
```

Two `formType` values are supported:

- **`complex_canadian_pp`** — the existing PsilocybinLabs flow, with full
  NI 45-106 Schedule A AI category picker, Schedule B FFBA, Schedule C
  US-AI initials, and Form 45-106F9 risk acknowledgement. Use this when
  the document has those schedules baked in.
- **`simple`** — the same multi-step form; for documents that don't have
  the Canadian-specific schedules, the AI/FFBA/US-AI sections still
  render (they're harmless if the template doesn't reference those
  placeholders) but generally the basic identity / address / units /
  signature fields are what get filled.

---

## 9. Pre-flight checklist before going live

- [ ] Open every generated DOCX in Word and confirm the formatting
      survives the merge (no missing pages, no broken tables, no
      stray placeholders like `{SUBSCRIBER_NAME}`).
- [ ] File a real test submission to yourself; confirm Olivia (or the
      configured `notifyEmail`) receives the email with both the DOCX
      and the Excel log attached.
- [ ] Open `subscriptions.xlsx` in Excel — bold header, sortable, all
      columns intact, no merged cells.
- [ ] Try a Stripe payment in test mode end-to-end. CSV row should
      flip from `PaymentStatus=pending` to `paid` and the Stripe
      dashboard should show the same `filingId` in metadata.
- [ ] If the host machine doesn't have Outlook, install Thunderbird (or
      another mail client) and confirm `.eml` files double-click open
      with attachments visible.
- [ ] Make sure the `notifyEmail` mailbox is monitored — there's no
      automated escalation if Olivia is on vacation.

---

## 10. Open items / nice-to-haves

| Priority | Item                                                                |
|----------|---------------------------------------------------------------------|
| P1       | **Stripe webhook** for `checkout.session.completed` — closes the gap when a customer pays but closes the browser before redirect. |
| P2       | Server-side validation matching the client-side validation (today the server trusts the client). |
| P2       | A "View filings" admin page that reads each deal's CSV — saves Olivia from opening the file manually. |
| P3       | Real silent send (Microsoft Graph `/sendMail` or Office 365 SMTP) so submissions email themselves without Outlook. |
| P3       | Per-deal Stripe accounts via Stripe Connect (today all deals share the one `STRIPE_SECRET_KEY`). |
| P3       | Edit / archive deals from /admin (today only create works). |

---

## 11. Where to ask questions

- **Legal / agreement content** — Sasa Jarvis at McMillan LLP (per the
  PsilocybinLabs agreement face page).
- **Issuer questions** — Ian McDonald · 1-647-407-2515 ·
  ian@northwardcap.com.
- **Code / portal questions** — read git log first; the comments in
  `scripts/serve.ps1` and `public/app.js` are deliberately verbose.
