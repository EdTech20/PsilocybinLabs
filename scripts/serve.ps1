# Multi-deal subscription portal — static files + per-deal APIs.
#
# Filesystem layout:
#   public/                 shared frontend (landing, admin, deal portal)
#   deals/<slug>/           one folder per deal
#       deal.json           metadata (name, issuer, currency, price, etc.)
#       template.docx       template with {PLACEHOLDERS} (admin-prepared)
#       subscriptions.csv   ledger
#       subscriptions.xlsx  regenerated from CSV after each filing
#       filings/<id>.docx   per-submission filed DOCX
#       filings/<id>.eml    per-submission email draft
#
# Routes:
#   GET  /                                    landing page
#   GET  /admin                               admin dashboard
#   GET  /d/<slug>                            investor portal for a deal
#   GET  /api/deals                           list deals (JSON)
#   GET  /api/deals/<slug>/config             deal config
#   GET  /api/deals/<slug>/template.docx      template binary
#   POST /api/deals/<slug>/submit             file a subscription
#   POST /api/deals/<slug>/stripe/checkout    create Stripe checkout session
#   GET  /api/deals/<slug>/stripe/status      verify + mark paid
#   POST /api/admin/deals                     multipart: create new deal

param(
    [int]$Port = 3000,
    [switch]$NoAutoOpen,
    [string]$StripeSecretKey = $env:STRIPE_SECRET_KEY,
    [string]$PortalUrl       = "http://localhost:$Port"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root      = (Resolve-Path "$PSScriptRoot\..").Path
$publicDir = Join-Path $root 'public'
$dealsDir  = Join-Path $root 'deals'
New-Item -ItemType Directory -Force -Path $dealsDir | Out-Null

$mime = @{
    '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'
    '.css'='text/css; charset=utf-8';   '.js'='application/javascript; charset=utf-8'
    '.json'='application/json; charset=utf-8'; '.svg'='image/svg+xml'
    '.png'='image/png'; '.jpg'='image/jpeg'; '.ico'='image/x-icon'
    '.docx'='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    '.csv'='text/csv; charset=utf-8'; '.woff2'='font/woff2'
}

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
function Send-Bytes  { param($Ctx,[int]$Status,[byte[]]$Bytes,[string]$ContentType='application/octet-stream')
    $Ctx.Response.StatusCode=$Status; $Ctx.Response.ContentType=$ContentType
    $Ctx.Response.ContentLength64=$Bytes.Length
    $Ctx.Response.OutputStream.Write($Bytes,0,$Bytes.Length); $Ctx.Response.OutputStream.Close()
}
function Send-Json   { param($Ctx,[int]$Status,$Obj)
    Send-Bytes $Ctx $Status ([Text.Encoding]::UTF8.GetBytes(($Obj|ConvertTo-Json -Depth 10 -Compress))) 'application/json; charset=utf-8'
}
function Send-Text   { param($Ctx,[int]$Status,[string]$T,[string]$Ct='text/plain; charset=utf-8')
    Send-Bytes $Ctx $Status ([Text.Encoding]::UTF8.GetBytes($T)) $Ct
}
function Read-BodyJson { param($Ctx)
    $sr=New-Object IO.StreamReader($Ctx.Request.InputStream,$Ctx.Request.ContentEncoding)
    $b=$sr.ReadToEnd(); $sr.Close(); $b|ConvertFrom-Json
}
function XmlEscape { param([string]$s) if ($null -eq $s) { return '' }
    ($s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '"','&quot;' -replace "'",'&apos;')
}
function CsvEscape { param([object]$v) if ($null -eq $v) { return '' }
    $s=[string]$v; if ($s -match '[",\r\n]') { return '"'+($s -replace '"','""')+'"' }; $s
}
function SafeName  { param([string]$s) if (-not $s) { return 'Subscriber' }
    (($s -replace '[^a-zA-Z0-9-]+','_').Trim('_'))
}
function SlugifyFor { param([string]$s) if (-not $s) { return '' }
    (($s.ToLower() -replace '[^a-z0-9-]+','-').Trim('-'))
}
function Stripe-Configured { return -not [string]::IsNullOrWhiteSpace($StripeSecretKey) }

# --------------------------------------------------------------------------
# Deal management
# --------------------------------------------------------------------------
function Get-DealPath { param([string]$Slug)
    $p = Join-Path $dealsDir $Slug
    if (-not (Test-Path $p) -or -not (Test-Path (Join-Path $p 'deal.json'))) { return $null }
    return $p
}
function Read-Deal { param([string]$Slug)
    $p = Get-DealPath $Slug
    if (-not $p) { return $null }
    $cfg = Get-Content (Join-Path $p 'deal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg | Add-Member -NotePropertyName 'path' -NotePropertyValue $p -Force
    return $cfg
}
function List-Deals {
    if (-not (Test-Path $dealsDir)) { return @() }
    Get-ChildItem -Path $dealsDir -Directory | ForEach-Object {
        $j = Join-Path $_.FullName 'deal.json'
        if (Test-Path $j) {
            try {
                $cfg = Get-Content $j -Raw -Encoding UTF8 | ConvertFrom-Json
                [pscustomobject]@{
                    slug          = $cfg.slug
                    displayName   = $cfg.displayName
                    issuer        = $cfg.issuer
                    currency      = $cfg.currency
                    unitPrice     = $cfg.unitPrice
                    unitNamePlural = $cfg.unitNamePlural
                    createdAt     = $cfg.createdAt
                }
            } catch {}
        }
    }
}

# --------------------------------------------------------------------------
# XLSX writer (regenerates workbook from CSV - CSV is source of truth)
# --------------------------------------------------------------------------
function Build-Xlsx {
    param([string]$CsvPath, [string]$XlsxPath)
    if (-not (Test-Path $CsvPath)) { return }
    $rows = @(Import-Csv -Path $CsvPath -Encoding UTF8)
    if (-not $rows) { return }
    $headers = $rows[0].PSObject.Properties.Name

    $colLetter = { param([int]$i) $i++; $s=''; while ($i -gt 0) { $m = ($i-1) % 26; $s=[char](65+$m)+$s; $i=[Math]::Floor(($i-1)/26) }; $s }

    $sh = [Text.StringBuilder]::new()
    [void]$sh.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
    [void]$sh.Append('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
    [void]$sh.Append('<row r="1">')
    for ($i=0; $i -lt $headers.Count; $i++) {
        $c = & $colLetter $i
        [void]$sh.Append("<c r=""${c}1"" t=""inlineStr"" s=""1""><is><t xml:space=""preserve"">$(XmlEscape $headers[$i])</t></is></c>")
    }
    [void]$sh.Append('</row>')
    $r=2
    foreach ($row in $rows) {
        [void]$sh.Append("<row r=""$r"">")
        for ($i=0; $i -lt $headers.Count; $i++) {
            $c = & $colLetter $i
            $val = [string]$row.$($headers[$i])
            [void]$sh.Append("<c r=""${c}${r}"" t=""inlineStr""><is><t xml:space=""preserve"">$(XmlEscape $val)</t></is></c>")
        }
        [void]$sh.Append('</row>')
        $r++
    }
    [void]$sh.Append('</sheetData></worksheet>')

    $wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Subscriptions" sheetId="1" r:id="rId1"/></sheets></workbook>'
    $wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    $rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    $ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
    $styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'

    $tmp = [IO.Path]::GetTempFileName() + '.xlsx'
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    $zip = [IO.Compression.ZipFile]::Open($tmp, 'Create')
    try {
        function Add-Entry { param($Z,[string]$N,[string]$C)
            $e = $Z.CreateEntry($N, [IO.Compression.CompressionLevel]::Optimal)
            $w = New-Object IO.StreamWriter($e.Open(), [Text.UTF8Encoding]::new($false))
            $w.Write($C); $w.Dispose()
        }
        Add-Entry $zip '[Content_Types].xml'  $ct
        Add-Entry $zip '_rels/.rels'          $rootRels
        Add-Entry $zip 'xl/workbook.xml'      $wb
        Add-Entry $zip 'xl/_rels/workbook.xml.rels' $wbRels
        Add-Entry $zip 'xl/styles.xml'        $styles
        Add-Entry $zip 'xl/worksheets/sheet1.xml' ($sh.ToString())
    } finally { $zip.Dispose() }
    try { Move-Item -Path $tmp -Destination $XlsxPath -Force }
    catch { Write-Warning "Could not overwrite $XlsxPath (open in Excel?). Draft kept at $tmp" }
}

# --------------------------------------------------------------------------
# Email draft (.eml with embedded attachments) - same as before
# --------------------------------------------------------------------------
function Get-Mime { param([string]$P) switch ([IO.Path]::GetExtension($P).ToLower()) {
    '.docx' { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    '.xlsx' { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    '.pdf'  { 'application/pdf' } '.csv' { 'text/csv; charset=utf-8' }
    default { 'application/octet-stream' } } }

function Build-Eml {
    param([string]$From,[string]$To,[string]$Subject,[string]$Body,[string[]]$Attachments)
    $boundary='SubDocPortal_'+([Guid]::NewGuid().ToString('N'))
    $sb=[Text.StringBuilder]::new()
    [void]$sb.AppendLine("From: $From"); [void]$sb.AppendLine("To: $To"); [void]$sb.AppendLine("Subject: $Subject")
    [void]$sb.AppendLine("Date: $((Get-Date).ToUniversalTime().ToString('r'))")
    [void]$sb.AppendLine('MIME-Version: 1.0')
    [void]$sb.AppendLine("Content-Type: multipart/mixed; boundary=`"$boundary`"")
    [void]$sb.AppendLine('X-Unsent: 1'); [void]$sb.AppendLine()
    [void]$sb.AppendLine('This is a multipart message in MIME format.'); [void]$sb.AppendLine()
    [void]$sb.AppendLine("--$boundary")
    [void]$sb.AppendLine('Content-Type: text/plain; charset=utf-8')
    [void]$sb.AppendLine('Content-Transfer-Encoding: 8bit'); [void]$sb.AppendLine()
    [void]$sb.AppendLine($Body)
    foreach ($a in $Attachments) {
        if (-not $a -or -not (Test-Path $a)) { continue }
        $name=[IO.Path]::GetFileName($a); $ct=Get-Mime $a
        $bytes=[IO.File]::ReadAllBytes($a)
        $b64=[Convert]::ToBase64String($bytes,[Base64FormattingOptions]::InsertLineBreaks)
        [void]$sb.AppendLine(); [void]$sb.AppendLine("--$boundary")
        [void]$sb.AppendLine("Content-Type: $ct; name=`"$name`"")
        [void]$sb.AppendLine('Content-Transfer-Encoding: base64')
        [void]$sb.AppendLine("Content-Disposition: attachment; filename=`"$name`""); [void]$sb.AppendLine()
        [void]$sb.AppendLine($b64)
    }
    [void]$sb.AppendLine(); [void]$sb.AppendLine("--$boundary--")
    return $sb.ToString()
}

function Queue-Email {
    param([string]$From,[string]$To,[string]$Subject,[string]$Body,[string[]]$Attachments,[string]$EmlPath)
    try {
        $eml = Build-Eml -From $From -To $To -Subject $Subject -Body $Body -Attachments $Attachments
        [IO.File]::WriteAllText($EmlPath, $eml, [Text.UTF8Encoding]::new($false))
        if (-not $NoAutoOpen) { Start-Process -FilePath $EmlPath -ErrorAction SilentlyContinue | Out-Null }
        return @{ ok=$true; method='eml-draft'; state=$(if ($NoAutoOpen) {'saved'} else {'opened'}); emlPath=$EmlPath }
    } catch { return @{ ok=$false; method='eml-draft'; error=$_.Exception.Message } }
}

# --------------------------------------------------------------------------
# Submission handler (per-deal)
# --------------------------------------------------------------------------
function Handle-Submit {
    param($Ctx, $Deal)
    $payload = Read-BodyJson $Ctx
    if (-not $payload.subscriberName -or -not $payload.docxBase64) {
        Send-Json $Ctx 400 @{ ok=$false; error='Missing subscriberName or docxBase64.' }; return
    }

    $filingsDir = Join-Path $Deal.path 'filings'
    New-Item -ItemType Directory -Force -Path $filingsDir | Out-Null
    $csvPath  = Join-Path $Deal.path 'subscriptions.csv'
    $xlsxPath = Join-Path $Deal.path 'subscriptions.xlsx'

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $safe  = SafeName $payload.subscriberName
    $docxName = "$($Deal.slug)_SubAgreement_${safe}_${stamp}.docx"
    $docxPath = Join-Path $filingsDir $docxName
    try { [IO.File]::WriteAllBytes($docxPath,[Convert]::FromBase64String($payload.docxBase64)) }
    catch { Send-Json $Ctx 500 @{ ok=$false; error="Failed to save DOCX: $($_.Exception.Message)" }; return }

    $shares = [int]($payload.numberOfShares)
    $aggregate = '{0:N2}' -f ($shares * [double]$Deal.unitPrice)
    $aiCats   = if ($payload.aiCategories)   { ($payload.aiCategories -join ';') } else { '' }
    $usAiCats = if ($payload.usAiCategories) { ($payload.usAiCategories -join ';') } else { '' }

    $row = [ordered]@{
        Timestamp        = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
        FilingId         = "$stamp-$safe"
        Deal             = $Deal.slug
        SubscriberName   = $payload.subscriberName
        EntityType       = $payload.entityType
        Email            = $payload.subscriberEmail
        Phone            = $payload.subscriberPhone
        AddressLine1     = $payload.subscriberAddressLine1
        AddressLine2     = $payload.subscriberAddressLine2
        City             = $payload.subscriberCity
        Province         = $payload.subscriberProvince
        Postal           = $payload.subscriberPostal
        Country          = $payload.subscriberCountry
        Jurisdiction     = $payload.jurisdictionOfResidence
        Shares           = $shares
        Currency         = $Deal.currency
        AggregateAmount  = $aggregate
        CurrentHoldings  = $payload.currentHoldings
        RegistrantStatus = $payload.registrantStatus
        Exemption        = $payload.exemptionCategory
        AICategories     = $aiCats
        USAICategories   = $usAiCats
        FFBACategory     = $payload.ffbaCategory
        FFBARelationshipName = $payload.ffbaRelationshipName
        DisclosedPrincipal   = $payload.disclosedPrincipalName
        ExecutionDate    = $payload.executionDate
        FilePath         = $docxPath
        PaymentMethod    = ''
        PaymentStatus    = 'pending'
        StripeSessionId  = ''
    }

    $headers = ($row.Keys   | ForEach-Object { CsvEscape $_ }) -join ','
    $values  = ($row.Values | ForEach-Object { CsvEscape $_ }) -join ','
    try {
        if (-not (Test-Path $csvPath)) {
            [IO.File]::WriteAllText($csvPath, "$headers`r`n$values`r`n", [Text.UTF8Encoding]::new($true))
        } else {
            [IO.File]::AppendAllText($csvPath, "$values`r`n", [Text.UTF8Encoding]::new($true))
        }
    } catch { Send-Json $Ctx 500 @{ ok=$false; error="Failed to append CSV: $($_.Exception.Message)" }; return }

    $xlsxResult = @{ ok=$true }
    try { Build-Xlsx -CsvPath $csvPath -XlsxPath $xlsxPath }
    catch { $xlsxResult = @{ ok=$false; error=$_.Exception.Message } }

    $body = @"
A new subscription has been submitted via the $($Deal.displayName) portal.

Deal:         $($Deal.displayName)
Issuer:       $($Deal.issuer)
Filing ID:    $($row.FilingId)
Subscriber:   $($row.SubscriberName) ($($row.EntityType))
Email:        $($row.Email)
Phone:        $($row.Phone)
Address:      $($row.AddressLine1), $($row.City), $($row.Province) $($row.Postal), $($row.Country)
Jurisdiction: $($row.Jurisdiction)
Shares:       $($row.Shares) @ $($Deal.currency) `$$($Deal.unitPrice)
Aggregate:    $($Deal.currency) `$$($row.AggregateAmount)
Exemption:    $($row.Exemption)$(if($aiCats){" (AI: $aiCats)"})$(if($usAiCats){" (US AI: $usAiCats)"})
Execution:    $($row.ExecutionDate)

Filed DOCX:   $docxPath
Excel log:    $xlsxPath

-- auto-filed by subscription portal
"@
    $subject = "[$($Deal.slug)] $($row.SubscriberName) - $($row.Shares) shares ($($Deal.currency) `$$($row.AggregateAmount))"
    $emlPath = Join-Path $filingsDir "$($row.FilingId).eml"
    $emailResult = Queue-Email -From $Deal.fromEmail -To $Deal.notifyEmail -Subject $subject -Body $body `
        -Attachments @($docxPath, $xlsxPath) -EmlPath $emlPath

    Send-Json $Ctx 200 @{
        ok = $true; filingId=$row.FilingId; deal=$Deal.slug
        docxPath=$docxPath; xlsxPath=$xlsxPath; csvPath=$csvPath
        email=$emailResult; xlsx=$xlsxResult
    }
}

# --------------------------------------------------------------------------
# Stripe (per-deal)
# --------------------------------------------------------------------------
function UrlEncode { param([string]$s) [uri]::EscapeDataString([string]$s) }
function Build-FormBody { param([hashtable]$F)
    $p=@(); foreach ($k in $F.Keys) { if ($null -eq $F[$k]) { continue }
        $p += "{0}={1}" -f (UrlEncode $k),(UrlEncode ([string]$F[$k])) }
    $p -join '&'
}

function Handle-StripeCheckout {
    param($Ctx, $Deal)
    if (-not (Stripe-Configured)) {
        Send-Json $Ctx 501 @{ ok=$false; error='STRIPE_SECRET_KEY not set on server.' }; return
    }
    $payload = Read-BodyJson $Ctx
    if (-not $payload.filingId -or -not $payload.numberOfShares -or -not $payload.subscriberName) {
        Send-Json $Ctx 400 @{ ok=$false; error='Missing filingId / numberOfShares / subscriberName.' }; return
    }
    $shares = [int]$payload.numberOfShares
    if ($shares -le 0) { Send-Json $Ctx 400 @{ ok=$false; error='Shares must be positive.' }; return }
    $unitCents = [int]([math]::Round([double]$Deal.unitPrice * 100))
    $currency  = $Deal.currency.ToLower()

    $fields = [ordered]@{
        'mode' = 'payment'
        'success_url' = "$PortalUrl/d/$($Deal.slug)/?paid=1&filing=$($payload.filingId)&session_id={CHECKOUT_SESSION_ID}"
        'cancel_url'  = "$PortalUrl/d/$($Deal.slug)/?cancelled=1&filing=$($payload.filingId)"
        'customer_email' = $payload.subscriberEmail
        'line_items[0][price_data][currency]'                = $currency
        'line_items[0][price_data][product_data][name]'      = "$($Deal.displayName) - $shares $($Deal.unitNamePlural)"
        'line_items[0][price_data][product_data][description]' = "Subscription for $shares $($Deal.unitNamePlural) at $($Deal.currency) `$$($Deal.unitPrice) each"
        'line_items[0][price_data][unit_amount]'             = $unitCents
        'line_items[0][quantity]'                            = $shares
        'metadata[deal]'                                     = $Deal.slug
        'metadata[filingId]'                                 = $payload.filingId
        'metadata[subscriberName]'                           = $payload.subscriberName
        'payment_intent_data[metadata][filingId]'            = $payload.filingId
        'payment_intent_data[metadata][deal]'                = $Deal.slug
    }
    try {
        $body = Build-FormBody $fields
        $resp = Invoke-RestMethod -Method POST -Uri 'https://api.stripe.com/v1/checkout/sessions' `
            -Headers @{ Authorization = "Bearer $StripeSecretKey" } `
            -ContentType 'application/x-www-form-urlencoded' -Body $body -ErrorAction Stop
        Send-Json $Ctx 200 @{ ok=$true; sessionId=$resp.id; url=$resp.url }
    } catch {
        $msg = $_.Exception.Message
        try { if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message } } catch {}
        Send-Json $Ctx 502 @{ ok=$false; error="Stripe error: $msg" }
    }
}

function Handle-StripeStatus {
    param($Ctx, $Deal, [string]$SessionId, [string]$FilingId)
    if (-not (Stripe-Configured)) { Send-Json $Ctx 501 @{ ok=$false; error='Stripe not configured' }; return }
    try {
        $resp = Invoke-RestMethod -Method GET -Uri "https://api.stripe.com/v1/checkout/sessions/$SessionId" `
            -Headers @{ Authorization = "Bearer $StripeSecretKey" } -ErrorAction Stop
        $paid = ($resp.payment_status -eq 'paid')
        $csvPath = Join-Path $Deal.path 'subscriptions.csv'
        if ($paid -and $FilingId -and (Test-Path $csvPath)) {
            $rows = @(Import-Csv $csvPath -Encoding UTF8); $changed=$false
            foreach ($r in $rows) {
                if ($r.FilingId -eq $FilingId) {
                    $r.PaymentMethod='stripe'; $r.PaymentStatus='paid'; $r.StripeSessionId=$SessionId; $changed=$true
                }
            }
            if ($changed) {
                $rows | Export-Csv -Path $csvPath -Encoding UTF8 -NoTypeInformation
                Build-Xlsx -CsvPath $csvPath -XlsxPath (Join-Path $Deal.path 'subscriptions.xlsx')
            }
        }
        Send-Json $Ctx 200 @{ ok=$true; paid=$paid; paymentStatus=$resp.payment_status; amountTotal=$resp.amount_total; currency=$resp.currency }
    } catch { Send-Json $Ctx 502 @{ ok=$false; error=$_.Exception.Message } }
}

# --------------------------------------------------------------------------
# Multipart form-data parser (admin upload of a new deal)
# --------------------------------------------------------------------------
function Parse-Multipart {
    param([byte[]]$Body, [string]$Boundary)
    $parts = @{}
    $boundaryBytes = [Text.Encoding]::ASCII.GetBytes("--$Boundary")
    # find positions of all boundaries
    $positions = @()
    for ($i=0; $i -le $Body.Length - $boundaryBytes.Length; $i++) {
        $match = $true
        for ($j=0; $j -lt $boundaryBytes.Length; $j++) {
            if ($Body[$i+$j] -ne $boundaryBytes[$j]) { $match = $false; break }
        }
        if ($match) { $positions += $i; $i += $boundaryBytes.Length - 1 }
    }
    if ($positions.Count -lt 2) { return $parts }

    for ($k=0; $k -lt $positions.Count - 1; $k++) {
        $start = $positions[$k] + $boundaryBytes.Length
        if ($Body[$start] -eq 13 -and $Body[$start+1] -eq 10) { $start += 2 }   # CRLF
        $end = $positions[$k+1]
        if ($Body[$end-2] -eq 13 -and $Body[$end-1] -eq 10) { $end -= 2 }       # trailing CRLF

        # Find header/body split: CRLF CRLF
        $headerEnd = -1
        for ($i=$start; $i -le $end-4; $i++) {
            if ($Body[$i] -eq 13 -and $Body[$i+1] -eq 10 -and $Body[$i+2] -eq 13 -and $Body[$i+3] -eq 10) {
                $headerEnd = $i; break
            }
        }
        if ($headerEnd -lt 0) { continue }

        $headerText = [Text.Encoding]::ASCII.GetString($Body, $start, $headerEnd - $start)
        $contentStart = $headerEnd + 4
        $contentLen   = $end - $contentStart
        if ($contentLen -lt 0) { $contentLen = 0 }
        $content = New-Object byte[] $contentLen
        if ($contentLen -gt 0) { [Array]::Copy($Body, $contentStart, $content, 0, $contentLen) }

        $name=$null; $filename=$null
        foreach ($line in $headerText -split "`r`n") {
            if ($line -match 'Content-Disposition:[^;]+;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?') {
                $name = $matches[1]; if ($matches[2]) { $filename = $matches[2] }
            }
        }
        if ($name) {
            $parts[$name] = @{ filename=$filename; bytes=$content; text=([Text.Encoding]::UTF8.GetString($content)) }
        }
    }
    return $parts
}

function Handle-AdminUploadDeal {
    param($Ctx)
    $req = $Ctx.Request
    $ct = $req.ContentType
    if (-not $ct -or $ct -notmatch 'boundary=([^;]+)') {
        Send-Json $Ctx 400 @{ ok=$false; error='Expected multipart/form-data with boundary.' }; return
    }
    $boundary = $matches[1].Trim('"')
    $ms = New-Object IO.MemoryStream
    $req.InputStream.CopyTo($ms)
    $bytes = $ms.ToArray(); $ms.Dispose()
    $parts = Parse-Multipart -Body $bytes -Boundary $boundary

    $required = @('displayName','issuer','currency','unitPrice','notifyEmail','template')
    foreach ($r in $required) { if (-not $parts.ContainsKey($r)) { Send-Json $Ctx 400 @{ ok=$false; error="Missing field: $r" }; return } }

    $slug = $parts['slug'].text
    if (-not $slug) { $slug = SlugifyFor $parts['displayName'].text }
    $slug = SlugifyFor $slug
    if (-not $slug) { Send-Json $Ctx 400 @{ ok=$false; error='Invalid or empty slug.' }; return }
    if (Get-DealPath $slug) { Send-Json $Ctx 409 @{ ok=$false; error="Deal '$slug' already exists." }; return }

    $tplPart = $parts['template']
    if (-not $tplPart.bytes -or $tplPart.bytes.Length -lt 100) { Send-Json $Ctx 400 @{ ok=$false; error='template upload empty or missing.' }; return }
    if ($tplPart.filename -and $tplPart.filename -notmatch '\.docx$') { Send-Json $Ctx 400 @{ ok=$false; error='Template must be a .docx file.' }; return }

    $dealPath = Join-Path $dealsDir $slug
    New-Item -ItemType Directory -Force -Path $dealPath | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $dealPath 'filings') | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $dealPath 'template.docx'), $tplPart.bytes)

    $unitName = $(if ($parts.ContainsKey('unitName'))       { $parts['unitName'].text }       else { 'common share' })
    $unitNameP= $(if ($parts.ContainsKey('unitNamePlural')) { $parts['unitNamePlural'].text } else { "$unitName" + 's' })
    $cfg = [ordered]@{
        slug          = $slug
        displayName   = $parts['displayName'].text
        issuer        = $parts['issuer'].text
        subTitle      = $(if ($parts.ContainsKey('subTitle')) { $parts['subTitle'].text } else { 'Private Placement Subscription Portal' })
        currency      = $parts['currency'].text.ToUpper()
        unitPrice     = [double]$parts['unitPrice'].text
        unitName      = $unitName
        unitNamePlural= $unitNameP
        formType      = $(if ($parts.ContainsKey('formType')) { $parts['formType'].text } else { 'simple' })
        notifyEmail   = $parts['notifyEmail'].text
        fromEmail     = $(if ($parts.ContainsKey('fromEmail')) { $parts['fromEmail'].text } else { "subscriptions@$slug.local" })
        stripeEnabled = $true
        wireInstructions = $(if ($parts.ContainsKey('wireInstructions')) { $parts['wireInstructions'].text } else { '' })
        createdAt     = (Get-Date -Format 'yyyy-MM-dd')
    }
    $cfg | ConvertTo-Json -Depth 5 | Out-File -FilePath (Join-Path $dealPath 'deal.json') -Encoding UTF8

    Send-Json $Ctx 200 @{ ok=$true; slug=$slug; url="/d/$slug/" }
}

# --------------------------------------------------------------------------
# Static file serving (with safe path resolution)
# --------------------------------------------------------------------------
function Serve-File {
    param($Ctx, [string]$BaseDir, [string]$RelPath)
    $full = Join-Path $BaseDir $RelPath
    $rp = Resolve-Path -LiteralPath $full -ErrorAction SilentlyContinue
    if (-not $rp -or -not $rp.Path.StartsWith($BaseDir, [StringComparison]::OrdinalIgnoreCase)) {
        Send-Text $Ctx 404 'Not found'; return
    }
    if (-not (Test-Path $rp.Path -PathType Leaf)) { Send-Text $Ctx 404 'Not found'; return }
    $ext = [IO.Path]::GetExtension($rp.Path).ToLower()
    $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    Send-Bytes $Ctx 200 ([IO.File]::ReadAllBytes($rp.Path)) $ct
}

# --------------------------------------------------------------------------
# HTTP listener
# --------------------------------------------------------------------------
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Sub Doc Portal: http://localhost:$Port/" -ForegroundColor Cyan
Write-Host "Public dir:    $publicDir"
Write-Host "Deals dir:     $dealsDir"
Write-Host ("Stripe:        {0}" -f $(if (Stripe-Configured) { 'ENABLED' } else { 'not configured' }))
Write-Host "Ctrl+C to stop."

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        try {
            $p = [uri]::UnescapeDataString($req.Url.AbsolutePath)
            $m = $req.HttpMethod

            # ---- API routes ----
            if ($m -eq 'GET' -and $p -eq '/api/deals') {
                Send-Json $ctx 200 @{ deals = @(List-Deals) }; continue
            }
            if ($m -eq 'GET' -and $p -eq '/api/config') {
                Send-Json $ctx 200 @{ stripeConfigured=(Stripe-Configured); portalUrl=$PortalUrl }; continue
            }
            if ($m -eq 'POST' -and $p -eq '/api/admin/deals') {
                Handle-AdminUploadDeal $ctx; continue
            }

            # ---- Per-deal API routes: /api/deals/<slug>/... ----
            if ($p -match '^/api/deals/([^/]+)/(.+)$') {
                $slug = $matches[1]; $rest = $matches[2]
                $deal = Read-Deal $slug
                if (-not $deal) { Send-Json $ctx 404 @{ ok=$false; error="Deal '$slug' not found" }; continue }
                if ($m -eq 'GET'  -and $rest -eq 'config')             { Send-Json $ctx 200 $deal; continue }
                if ($m -eq 'GET'  -and $rest -eq 'template.docx')      { Serve-File $ctx $deal.path 'template.docx'; continue }
                if ($m -eq 'POST' -and $rest -eq 'submit')             { Handle-Submit $ctx $deal; continue }
                if ($m -eq 'POST' -and $rest -eq 'stripe/checkout')    { Handle-StripeCheckout $ctx $deal; continue }
                if ($m -eq 'GET'  -and $rest -eq 'stripe/status')      { Handle-StripeStatus $ctx $deal $req.QueryString['session_id'] $req.QueryString['filing']; continue }
                Send-Json $ctx 404 @{ ok=$false; error="Unknown deal route /$rest" }; continue
            }

            # ---- Page routes ----
            if ($m -eq 'GET' -and $p -eq '/')        { Serve-File $ctx $publicDir 'landing.html'; continue }
            if ($m -eq 'GET' -and $p -eq '/admin')   { Serve-File $ctx $publicDir 'admin.html'; continue }
            if ($m -eq 'GET' -and $p -match '^/d/([^/]+)/?$') {
                $slug = $matches[1]
                if (-not (Get-DealPath $slug)) { Send-Text $ctx 404 "Deal '$slug' not found"; continue }
                Serve-File $ctx $publicDir 'index.html'; continue
            }

            # ---- Static assets in public/ ----
            $rel = $p.TrimStart('/')
            if (-not $rel) { $rel = 'landing.html' }
            Serve-File $ctx $publicDir $rel
        } catch {
            try { Send-Json $ctx 500 @{ ok=$false; error="Server error: $($_.Exception.Message)" } } catch {}
            Write-Warning "Server error: $($_.Exception.Message)"
        }
    }
} finally { $listener.Stop() }
