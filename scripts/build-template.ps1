# Builds a templated DOCX from the original subscription agreement by:
#  1. Inserting full placeholder paragraphs before anchor labels (face-page
#     identity / address fields that are handwritten in the original).
#  2. Inserting inline placeholder runs at the START of each AI / FFBA / US-AI
#     category paragraph and each risk-acknowledgement row, so selected
#     categories display the subscriber's initials (blank when not selected).
#  3. Filling labeled blanks (investment amount, $_____, names, dates).
#
# Input : sample_agreement.docx (original)
# Output: templates/template.docx (docxtemplater template)

param(
    [string]$Source = "$PSScriptRoot\..\sample_agreement.docx",
    [string]$Dest   = "$PSScriptRoot\..\templates\template.docx"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$workDir = Join-Path $env:TEMP "subdoc_template_build"
if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
New-Item -ItemType Directory -Path $workDir | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($Source, $workDir)

$docPath = Join-Path $workDir "word\document.xml"
$xml = Get-Content $docPath -Raw -Encoding UTF8

# --------------------------------------------------------------------------
# Helper: insert a fresh paragraph (TNR 10pt) before the paragraph
# containing $AnchorText.
# --------------------------------------------------------------------------
function New-PlaceholderParagraph {
    param([string]$Placeholder, [string]$RsidR = '00D12C72')
    $safe = $Placeholder -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;'
    return "<w:p w:rsidR=`"$RsidR`"><w:pPr><w:spacing w:after=`"0`" /><w:rPr><w:rFonts w:ascii=`"Times New Roman`" w:hAnsi=`"Times New Roman`" /><w:sz w:val=`"20`" /></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii=`"Times New Roman`" w:hAnsi=`"Times New Roman`" /><w:sz w:val=`"20`" /></w:rPr><w:t xml:space=`"preserve`">$safe</w:t></w:r></w:p>"
}

function Insert-Before-Anchor {
    param([ref]$XmlRef, [string]$AnchorText, [string]$PlaceholderText, [int]$Occurrence = 1)
    $x = $XmlRef.Value
    $searchStart = 0
    for ($i = 1; $i -le $Occurrence; $i++) {
        $anchorIdx = $x.IndexOf($AnchorText, $searchStart)
        if ($anchorIdx -lt 0) { Write-Warning "Anchor not found: $AnchorText (occurrence $i)"; return }
        $searchStart = $anchorIdx + 1
        if ($i -lt $Occurrence) { continue }

        $closeTag = '</w:p>'
        $insertAt = $x.LastIndexOf($closeTag, $anchorIdx)
        if ($insertAt -lt 0) { Write-Warning "No preceding </w:p> for: $AnchorText"; return }
        $insertAt += $closeTag.Length

        $x = $x.Insert($insertAt, (New-PlaceholderParagraph $PlaceholderText))
        $XmlRef.Value = $x
    }
}

# --------------------------------------------------------------------------
# Helper: insert a new inline <w:r> BEFORE the run containing $AnchorText,
# so initials/checkmarks prefix the existing category text.
# --------------------------------------------------------------------------
function Insert-Run-Before-Anchor {
    param([ref]$XmlRef, [string]$AnchorText, [string]$PlaceholderText, [int]$Occurrence = 1, [switch]$Bold)
    $x = $XmlRef.Value
    $searchStart = 0
    $anchorIdx = -1
    for ($i = 1; $i -le $Occurrence; $i++) {
        $anchorIdx = $x.IndexOf($AnchorText, $searchStart)
        if ($anchorIdx -lt 0) { Write-Warning "Run anchor not found: $AnchorText (occurrence $i)"; return }
        $searchStart = $anchorIdx + 1
    }
    $runStart = [Math]::Max($x.LastIndexOf('<w:r ', $anchorIdx), $x.LastIndexOf('<w:r>', $anchorIdx))
    if ($runStart -lt 0) { Write-Warning "No preceding <w:r for: $AnchorText"; return }

    $boldTag = if ($Bold) { '<w:b />' } else { '' }
    $newRun = "<w:r><w:rPr><w:rFonts w:ascii=`"Times New Roman`" w:hAnsi=`"Times New Roman`" /><w:sz w:val=`"20`" />$boldTag</w:rPr><w:t xml:space=`"preserve`">$PlaceholderText</w:t></w:r>"
    $XmlRef.Value = $x.Insert($runStart, $newRun)
}

# ================================================================
# FACE PAGE
# ================================================================
Insert-Before-Anchor ([ref]$xml) "Name of Subscriber - please print" "{SUBSCRIBER_NAME}"
Insert-Before-Anchor ([ref]$xml) "Official Capacity or Title - please print" "{OFFICIAL_CAPACITY}"
Insert-Before-Anchor ([ref]$xml) "Please print name of individual whose signature appears above" "{SIGNATORY_NAME}"
Insert-Before-Anchor ([ref]$xml) "Subscriber's Address" "{SUBSCRIBER_ADDRESS}"
Insert-Before-Anchor ([ref]$xml) "Telephone Number" "{SUBSCRIBER_PHONE}   {SUBSCRIBER_EMAIL}" 1

$xml = $xml -replace '(<w:t[^>]*>Number of Shares:</w:t>)', '$1<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" /><w:b /><w:sz w:val="20" /></w:rPr><w:t xml:space="preserve"> {NUMBER_OF_SHARES}</w:t></w:r>'
$xml = $xml -replace '(<w:t[^>]*>Aggregate Subscription Price: ?</w:t>)', '$1<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" /><w:b /><w:sz w:val="20" /></w:rPr><w:t xml:space="preserve"> CAD ${AGGREGATE_PRICE}</w:t></w:r>'
$xml = $xml -replace '(<w:t[^>]*>Subscription No\.:</w:t>)', '$1<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" /><w:sz w:val="20" /></w:rPr><w:t xml:space="preserve"> {SUBSCRIPTION_NO}</w:t></w:r>'

Insert-Before-Anchor ([ref]$xml) "Name of Disclosed Principal" "{DISCLOSED_PRINCIPAL_NAME}"
Insert-Before-Anchor ([ref]$xml) "Disclosed Principal's Address" "{DISCLOSED_PRINCIPAL_ADDRESS}"
Insert-Before-Anchor ([ref]$xml) "Account reference, if applicable" "{REG_NAME}" 1
Insert-Before-Anchor ([ref]$xml) "including postal code" "{REG_ADDRESS}" 1

# Registrant status checkboxes on face page (split across runs w/ leading space)
Insert-Run-Before-Anchor ([ref]$xml) 'The Subscriber is a person registered or required' '{REGISTERED_CHECK} ' 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) 'The Subscriber is NOT a person registered or required' '{NOT_REGISTERED_CHECK} ' 1 -Bold

# Current holdings ("Common shares of the Company.") - add initials prefix
Insert-Run-Before-Anchor ([ref]$xml) 'Common shares of the Company' '{CURRENT_HOLDINGS} ' 1 -Bold

# ================================================================
# SCHEDULE A Part 1 - Accredited Investor categories (initials prefix)
# ================================================================
$aiAnchors = @{
    'a'  = 'Canadian financial institution'   # first occurrence, split across runs
    'b'  = 'except in Ontario, the Business Development Bank of Canada'
    'c'  = 'except in Ontario, a subsidiary of any person referred to in paragraph (a) or (b)'
    'd'  = 'except in Ontario, a person registered under the securities legislation'
    'e'  = 'an individual registered or formerly registered under the securities legislation of a jurisdiction of Canada as a representative'
    'e1' = 'an individual formerly registered under the securities legislation of a jurisdiction of Canada, other than an individual formerly registered solely'
    'f'  = 'except in Ontario, the Government of Canada or a jurisdiction of Canada'
    'g'  = 'except in Ontario, a municipality, public board or commission in Canada'
    'h'  = 'except in Ontario, any national, federal, state, provincial, territorial or municipal government'
    'i'  = 'except in Ontario, a pension fund that is regulated by the Office'
    'j'  = 'an individual who, either alone or with a spouse, beneficially owns financial assets having an aggregate realizable value that, before taxes, but net of any related liabilities, exceeds $1,000,000'
    'j1' = 'an individual who beneficially owns financial assets having an aggregate realizable value that, before taxes but net of any related liabilities, exceeds $5,000,000'
    'k'  = 'an individual whose net income before taxes exceeded $200,000'
    'l'  = 'an individual who, either alone or with a spouse, has net assets of at least $5,000,000'
    'm'  = 'a person, other than an individual or investment fund, that has net assets of at least $5,000,000'
    'n'  = 'an investment fund that distributes or has distributed its securities only to'
    'o'  = 'an investment fund that distributes or has distributed securities under a prospectus'
    'p'  = 'a trust company or trust corporation registered or authorized to carry on business'
    'q'  = 'a person acting on behalf of a fully managed account managed by that person'
    'r'  = 'a registered charity under the Income Tax Act'
    's'  = 'an entity organized in a foreign jurisdiction that is analogous to any of the entities'
    't'  = 'a person in respect of which all of the owners of interests, direct, indirect or beneficial'
    'u'  = 'an investment fund that is advised by a person registered as an adviser'
    'v'  = 'a person that is recognized or designated by the securities regulatory authority'
    'w'  = 'a trust established by an accredited investor for the benefit of the accredited investor'
}
foreach ($code in $aiAnchors.Keys) {
    Insert-Run-Before-Anchor ([ref]$xml) $aiAnchors[$code] "{AI_$code} " 1 -Bold
}

# ================================================================
# SCHEDULE A Part 2 - Ontario-specific AI categories
# ================================================================
$aionAnchors = @{
    'a' = 'a financial institutional listed in Schedule I, II or III'
    'b' = 'the Business Development Bank of Canada,'
    'c' = 'a subsidiary of any person referred to in paragraph (a) or (b), if the person owns all of the voting securities of the subsidiary, except the voting securities required by law to be owned by directors of that subsidiary,'
    'd' = 'a person or company registered under the securities legislation of a province or territory of Canada as an adviser or dealer'
    'e' = 'the Government of Canada, the government of a province or territory of Canada, or any Crown corporation'
    'f' = 'a municipality, public board or commission in Canada and a metropolitan community, school board, the Comit'
    'g' = 'any national, federal, state, provincial, territorial or municipal government of or in any foreign jurisdiction, or any agency of that government,'
    'h' = 'a pension fund that is regulated by the Office of the Superintendent of Financial Institutions (Canada) or a pension commission or similar regulatory authority of a jurisdiction of Canada, or'
    'i' = 'A person or company that is recognized or designated by the Ontario Securities Commission'
}
foreach ($code in $aionAnchors.Keys) {
    Insert-Run-Before-Anchor ([ref]$xml) $aionAnchors[$code] "{AION_$code} " 1 -Bold
}

# Schedule A sign-off section (date / name / jurisdiction)
Insert-Before-Anchor ([ref]$xml) "Print the name of Subscriber" "{SUBSCRIBER_NAME}"
Insert-Before-Anchor ([ref]$xml) "Jurisdiction of Residence" "{JURISDICTION_OF_RESIDENCE}"
Insert-Before-Anchor ([ref]$xml) "If Subscriber is a corporation" "{AUTH_SIGNATORY_NAME_TITLE}"

# Dated line in Schedule A (two variants: "Dated:" alone and "Dated:   " with
# trailing spaces, each followed by a separate "20__" / ", 201__" run), and
# Schedule B's full "Dated:  _______________________, 201__." line.
$xml = $xml -replace '<w:t[^>]*>\s*Dated:\s*</w:t>',        '<w:t xml:space="preserve">Dated: {EXECUTION_DATE}</w:t>'
$xml = $xml -replace '<w:t[^>]*>Dated:  _______________________, 201__\.</w:t>', '<w:t xml:space="preserve">Dated: {EXECUTION_DATE}.</w:t>'
# Strip dangling year blanks "201__", " 201__", ", 201__", " 20__." that live
# in separate runs after the Dated label.
$xml = $xml -replace '<w:t[^>]*>,?\s*201__\s*</w:t>',  '<w:t xml:space="preserve"></w:t>'
$xml = $xml -replace '<w:t[^>]*>\s*20__\.\s*</w:t>',   '<w:t xml:space="preserve"></w:t>'

# ================================================================
# Appendix 1 to Schedule A - Form 45-106F9 risk acknowledgements
# ================================================================
# Investment amount on F9 (done earlier via general replace)
$xml = $xml -replace 'You could lose your entire investment of \$________________\.', 'You could lose your entire investment of ${AGGREGATE_PRICE}.'
$xml = $xml -replace 'You could lose your entire investment of \$________\.', 'You could lose your entire investment of ${AGGREGATE_PRICE}.'

# Risk acknowledgement initials (F9 section 2)
Insert-Run-Before-Anchor ([ref]$xml) "Risk of loss" "{F9_RISK_LOSS} " 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) "Liquidity risk" "{F9_RISK_LIQUIDITY} " 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) "Lack of information" "{F9_RISK_INFO} " 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) "Lack of advice" "{F9_RISK_ADVICE} " 1 -Bold

# AI status initials (F9 section 3)
Insert-Run-Before-Anchor ([ref]$xml) "Your net income before taxes was more than `$200,000" "{F9_AI_INCOME_200K} " 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) "Your net income before taxes combined with your spouse" "{F9_AI_INCOME_JOINT} " 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) "Either alone or with your spouse, you own more than `$1 million" "{F9_AI_ASSETS_1M} " 1 -Bold
Insert-Run-Before-Anchor ([ref]$xml) "Either alone or with your spouse, you may have net assets worth more than" "{F9_AI_NETWORTH_5M} " 1 -Bold

# F9 name / signature / date
$xml = $xml -replace '(<w:t[^>]*>)First and last name \(please print\):(</w:t>)', '$1First and last name (please print): {F9_NAME}$2'
$xml = $xml -replace '(<w:t[^>]*>)Signature:(</w:t>)', '$1Signature: {F9_SIGNATURE}$2'
$xml = $xml -replace '(<w:t[^>]*>)Date: (</w:t>)', '$1Date: {F9_DATE}$2'

# ================================================================
# SCHEDULE B - FFBA categories (already have "___(a)", "___(b)" prefixes)
# ================================================================
$ffbaAnchors = @{
    'a' = 'a director, executive officer or control person of the Issuer, or of an affiliate of the Issuer; or '
    'b' = 'a spouse, parent, grandparent, brother, sister, child or grandchild of a director, executive officer or control person of the Issuer, or of an affiliate of the Issuer; or'
    'c' = 'a parent, grandparent, brother, sister, child or grandchild of the spouse of a director, executive officer or control person'
    'd' = 'a close personal friend (by reason of the fact that you have directly known such individual well enough'
    'e' = 'a close business associate (by reason of the fact that you have had direct sufficient prior business dealings'
    'f' = 'a founder of the Issuer or a spouse, parent, grandparent, brother, sister, child, grandchild, close personal friend'
    'g' = 'a parent, grandparent, brother, sister, child or grandchild of a spouse of a founder'
    'h' = 'a person or company of which a majority of the voting securities are beneficially owned by'
    'i' = 'a trust or estate of which all of the beneficiaries or a majority of the trustees'
}
foreach ($code in $ffbaAnchors.Keys) {
    Insert-Run-Before-Anchor ([ref]$xml) $ffbaAnchors[$code] "{FFBA_$code} " 1 -Bold
}

# FFBA relationship details
Insert-Before-Anchor ([ref]$xml) "insert name of applicable person" "{FFBA_RELATIONSHIP_NAME}"
Insert-Before-Anchor ([ref]$xml) "Length of Relationship" "{FFBA_RELATIONSHIP_LENGTH}"
Insert-Before-Anchor ([ref]$xml) "Details of Relationship" "{FFBA_RELATIONSHIP_NATURE}"
Insert-Before-Anchor ([ref]$xml) "Prior Business Dealings, if applicable" "{FFBA_PRIOR_DEALINGS}"

# ================================================================
# SCHEDULE C - US Accredited Investor categories (1-8)
# Each has "Initials _______" above it
# ================================================================
for ($n = 1; $n -le 8; $n++) {
    # ${1} syntax (not $1) prevents the next literal digit from being swallowed
    # into an ambiguous group reference like $11.
    $xml = $xml -replace ("(<w:t[^>]*>){0}\. Initials _______(</w:t>)" -f $n),
        ("`${1}$n. Initials {USAI_$n}`${2}")
}
$xml = $xml -replace '<w:t[^>]*>Dated _______________ 201__\.</w:t>', '<w:t xml:space="preserve">Dated {EXECUTION_DATE}.</w:t>'
$xml = $xml -replace '<w:t[^>]*>Dated _______________ 20__\.</w:t>', '<w:t xml:space="preserve">Dated {EXECUTION_DATE}.</w:t>'

# ================================================================
# Save modified document.xml
# ================================================================
[System.IO.File]::WriteAllText($docPath, $xml, [System.Text.UTF8Encoding]::new($false))

$destDir = Split-Path -Parent $Dest
if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }
if (Test-Path $Dest) { Remove-Item $Dest -Force }

Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::Open($Dest, 'Create')
Get-ChildItem -Path $workDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($workDir.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
}
$zip.Dispose()

$placeholders = [regex]::Matches($xml, '\{[A-Za-z_][A-Za-z0-9_]*\}') | ForEach-Object { $_.Value } | Sort-Object -Unique
Write-Host "Template written to: $Dest"
Write-Host "Size: $((Get-Item $Dest).Length) bytes"
Write-Host "Placeholders ($($placeholders.Count)):"
$placeholders | ForEach-Object { Write-Host "  $_" }
