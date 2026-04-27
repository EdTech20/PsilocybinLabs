# Export INSTRUCTIONS.md (or any Markdown file) to a polished .docx that an
# assistant can open in Word, annotate, and print. Pure PowerShell - no
# Pandoc, no Word automation, no external modules.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/export-instructions.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/export-instructions.ps1 -Source README.md -Dest README.docx

param(
    [string]$Source = "$PSScriptRoot\..\INSTRUCTIONS.md",
    [string]$Dest   = "$PSScriptRoot\..\AutoSubDoc_Instructions.docx"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $Source)) { throw "Source not found: $Source" }
$lines = [IO.File]::ReadAllLines($Source)

# --------------------------------------------------------------------------
# XML helpers
# --------------------------------------------------------------------------
function XmlEscape {
    param([string]$s)
    if ($null -eq $s) { return '' }
    return ($s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '"','&quot;' -replace "'",'&apos;')
}

# Render inline markdown (bold/italic/code/link) into a sequence of <w:r> runs.
function Render-Inline {
    param([string]$text)
    if (-not $text) { return '' }

    # Tokenize: emit either { kind:'text|code|bold|italic|link', value, [url] }
    $out = [Text.StringBuilder]::new()
    $i = 0; $len = $text.Length
    $buf = [Text.StringBuilder]::new()

    function Flush-Plain {
        param($b, $o)
        if ($b.Length -gt 0) {
            [void]$o.Append("<w:r><w:rPr><w:rFonts w:ascii=`"Calibri`" w:hAnsi=`"Calibri`"/><w:sz w:val=`"22`"/></w:rPr><w:t xml:space=`"preserve`">$(XmlEscape $b.ToString())</w:t></w:r>")
            [void]$b.Clear()
        }
    }

    while ($i -lt $len) {
        $ch = $text[$i]
        # Inline code: `...`
        if ($ch -eq '`') {
            $end = $text.IndexOf('`', $i + 1)
            if ($end -gt $i) {
                Flush-Plain $buf $out
                $code = $text.Substring($i + 1, $end - $i - 1)
                [void]$out.Append("<w:r><w:rPr><w:rFonts w:ascii=`"Consolas`" w:hAnsi=`"Consolas`"/><w:sz w:val=`"20`"/><w:shd w:val=`"clear`" w:color=`"auto`" w:fill=`"F1F2F6`"/></w:rPr><w:t xml:space=`"preserve`">$(XmlEscape $code)</w:t></w:r>")
                $i = $end + 1; continue
            }
        }
        # Bold: **...**
        if ($ch -eq '*' -and $i + 1 -lt $len -and $text[$i+1] -eq '*') {
            $end = $text.IndexOf('**', $i + 2)
            if ($end -gt $i + 1) {
                Flush-Plain $buf $out
                $bold = $text.Substring($i + 2, $end - $i - 2)
                [void]$out.Append("<w:r><w:rPr><w:rFonts w:ascii=`"Calibri`" w:hAnsi=`"Calibri`"/><w:b/><w:sz w:val=`"22`"/></w:rPr><w:t xml:space=`"preserve`">$(XmlEscape $bold)</w:t></w:r>")
                $i = $end + 2; continue
            }
        }
        # Italic: *...* (single)
        if ($ch -eq '*' -and ($i + 1 -lt $len) -and $text[$i+1] -ne '*') {
            $end = $text.IndexOf('*', $i + 1)
            # Avoid swallowing the next ** by checking the char after the closer
            if ($end -gt $i -and ($end + 1 -ge $len -or $text[$end+1] -ne '*')) {
                Flush-Plain $buf $out
                $em = $text.Substring($i + 1, $end - $i - 1)
                [void]$out.Append("<w:r><w:rPr><w:rFonts w:ascii=`"Calibri`" w:hAnsi=`"Calibri`"/><w:i/><w:sz w:val=`"22`"/></w:rPr><w:t xml:space=`"preserve`">$(XmlEscape $em)</w:t></w:r>")
                $i = $end + 1; continue
            }
        }
        # Link: [text](url)
        if ($ch -eq '[') {
            $closeBracket = $text.IndexOf(']', $i + 1)
            if ($closeBracket -gt $i -and $closeBracket + 1 -lt $len -and $text[$closeBracket + 1] -eq '(') {
                $closeParen = $text.IndexOf(')', $closeBracket + 2)
                if ($closeParen -gt $closeBracket) {
                    Flush-Plain $buf $out
                    $linkText = $text.Substring($i + 1, $closeBracket - $i - 1)
                    # Render the visible text in a link-style run (we don't bother with hyperlink relationships)
                    [void]$out.Append("<w:r><w:rPr><w:rFonts w:ascii=`"Calibri`" w:hAnsi=`"Calibri`"/><w:color w:val=`"3F5EFB`"/><w:u w:val=`"single`"/><w:sz w:val=`"22`"/></w:rPr><w:t xml:space=`"preserve`">$(XmlEscape $linkText)</w:t></w:r>")
                    $i = $closeParen + 1; continue
                }
            }
        }

        [void]$buf.Append($ch); $i++
    }
    Flush-Plain $buf $out
    return $out.ToString()
}

# --------------------------------------------------------------------------
# Block builders
# --------------------------------------------------------------------------
function Para-Heading {
    param([int]$Level, [string]$Text)
    $sizes  = @{ 1 = 48; 2 = 32; 3 = 26 }   # half-points
    $space  = @{ 1 = '320'; 2 = '240'; 3 = '180' }
    $sz = $sizes[$Level]; $sp = $space[$Level]
    $inline = Render-Inline $Text
    # The inline runs above include their own Calibri 22; for a heading we
    # override with bold + larger size by wrapping in our own runs instead.
    $safe = XmlEscape $Text
    return "<w:p><w:pPr><w:spacing w:before=`"$sp`" w:after=`"120`"/><w:keepNext/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=`"Calibri`" w:hAnsi=`"Calibri`"/><w:b/><w:color w:val=`"131722`"/><w:sz w:val=`"$sz`"/></w:rPr><w:t xml:space=`"preserve`">$safe</w:t></w:r></w:p>"
}

function Para-Body {
    param([string]$Text)
    $inline = Render-Inline $Text
    return "<w:p><w:pPr><w:spacing w:after=`"120`"/></w:pPr>$inline</w:p>"
}

function Para-CodeLine {
    param([string]$Text)
    return "<w:p><w:pPr><w:spacing w:after=`"0`"/><w:shd w:val=`"clear`" w:color=`"auto`" w:fill=`"F4F5F8`"/><w:ind w:left=`"240`"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=`"Consolas`" w:hAnsi=`"Consolas`"/><w:sz w:val=`"20`"/></w:rPr><w:t xml:space=`"preserve`">$(XmlEscape $Text)</w:t></w:r></w:p>"
}

function Para-ListItem {
    param([string]$Text, [string]$Style = 'bullet', [int]$Indent = 0)
    $numId = if ($Style -eq 'bullet') { '1' } else { '2' }
    $inline = Render-Inline $Text
    $ind = 360 + ($Indent * 360)
    return "<w:p><w:pPr><w:numPr><w:ilvl w:val=`"$Indent`"/><w:numId w:val=`"$numId`"/></w:numPr><w:spacing w:after=`"60`"/><w:ind w:left=`"$ind`"/></w:pPr>$inline</w:p>"
}

function Para-Hr {
    return "<w:p><w:pPr><w:pBdr><w:bottom w:val=`"single`" w:sz=`"6`" w:space=`"1`" w:color=`"E3E6EC`"/></w:pBdr><w:spacing w:after=`"160`"/></w:pPr></w:p>"
}

# Build a table from collected rows. First row is the header.
function Build-Table {
    param([string[][]]$Rows)
    if (-not $Rows -or $Rows.Count -lt 1) { return '' }
    $cols = ($Rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
    $sb = [Text.StringBuilder]::new()
    [void]$sb.Append('<w:tbl>')
    [void]$sb.Append('<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C7CCD6"/><w:left w:val="single" w:sz="4" w:color="C7CCD6"/><w:bottom w:val="single" w:sz="4" w:color="C7CCD6"/><w:right w:val="single" w:sz="4" w:color="C7CCD6"/><w:insideH w:val="single" w:sz="4" w:color="E3E6EC"/><w:insideV w:val="single" w:sz="4" w:color="E3E6EC"/></w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr>')
    [void]$sb.Append('<w:tblGrid>')
    for ($g = 0; $g -lt $cols; $g++) { [void]$sb.Append('<w:gridCol/>') }
    [void]$sb.Append('</w:tblGrid>')
    for ($r = 0; $r -lt $Rows.Count; $r++) {
        $isHeader = ($r -eq 0)
        [void]$sb.Append('<w:tr>')
        if ($isHeader) { [void]$sb.Append('<w:trPr><w:tblHeader/></w:trPr>') }
        for ($c = 0; $c -lt $cols; $c++) {
            $cell = if ($c -lt $Rows[$r].Count) { $Rows[$r][$c] } else { '' }
            $shd = if ($isHeader) { '<w:shd w:val="clear" w:color="auto" w:fill="EDF1FF"/>' } else { '' }
            [void]$sb.Append('<w:tc>')
            [void]$sb.Append("<w:tcPr>$shd</w:tcPr>")
            $inline = Render-Inline $cell
            if ($isHeader) {
                $safeText = XmlEscape $cell
                $inline = "<w:r><w:rPr><w:rFonts w:ascii=`"Calibri`" w:hAnsi=`"Calibri`"/><w:b/><w:sz w:val=`"22`"/></w:rPr><w:t xml:space=`"preserve`">$safeText</w:t></w:r>"
            }
            [void]$sb.Append("<w:p><w:pPr><w:spacing w:after=`"40`"/></w:pPr>$inline</w:p>")
            [void]$sb.Append('</w:tc>')
        }
        [void]$sb.Append('</w:tr>')
    }
    [void]$sb.Append('</w:tbl>')
    # Empty paragraph after table (Word requires)
    [void]$sb.Append('<w:p/>')
    return $sb.ToString()
}

# --------------------------------------------------------------------------
# Block-level parser
# --------------------------------------------------------------------------
$body = [Text.StringBuilder]::new()
$inCode = $false
$codeFence = $null
$codeLines = @()
$tableRows = $null

function Flush-Table {
    param($Rows, $BodyBuilder)
    if ($null -eq $Rows) { return $null }
    $clean = @()
    foreach ($r in $Rows) {
        # Drop separator rows like |----|----|
        $joined = ($r -join '')
        if ($joined -match '^[-:\s]+$') { continue }
        $clean += ,$r
    }
    if ($clean.Count -gt 0) {
        [void]$BodyBuilder.Append((Build-Table $clean))
    }
    return $null
}

for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]

    # Code fence boundary
    if ($line -match '^(```|~~~)') {
        if ($inCode) {
            # Close fence: emit collected code lines as monospace paragraphs
            foreach ($cl in $codeLines) { [void]$body.Append((Para-CodeLine $cl)) }
            $inCode = $false; $codeFence = $null; $codeLines = @()
        } else {
            if ($null -ne $tableRows) { $tableRows = Flush-Table $tableRows }
            $inCode = $true; $codeFence = $matches[1]; $codeLines = @()
        }
        continue
    }
    if ($inCode) { $codeLines += $line; continue }

    # Table rows: lines starting and ending with |
    if ($line -match '^\s*\|.*\|\s*$') {
        $cells = ($line.Trim().Trim('|') -split '\|') | ForEach-Object { $_.Trim() }
        if ($null -eq $tableRows) { $tableRows = @() }
        $tableRows += ,$cells
        continue
    } elseif ($null -ne $tableRows) {
        $tableRows = Flush-Table $tableRows $body
    }

    # Headings
    if ($line -match '^(#{1,3})\s+(.*)$') {
        [void]$body.Append((Para-Heading $matches[1].Length $matches[2]))
        continue
    }

    # Horizontal rule
    if ($line -match '^\s*---\s*$' -or $line -match '^\s*\*\*\*\s*$') {
        [void]$body.Append((Para-Hr))
        continue
    }

    # Bullet / numbered list
    if ($line -match '^(\s*)[-\*]\s+(.*)$') {
        $indent = [Math]::Min(2, [int]([Math]::Floor($matches[1].Length / 2)))
        [void]$body.Append((Para-ListItem $matches[2] 'bullet' $indent))
        continue
    }
    if ($line -match '^(\s*)\d+\.\s+(.*)$') {
        $indent = [Math]::Min(2, [int]([Math]::Floor($matches[1].Length / 2)))
        [void]$body.Append((Para-ListItem $matches[2] 'number' $indent))
        continue
    }

    # Blank line -> empty paragraph (preserves spacing without doubling)
    if ([string]::IsNullOrWhiteSpace($line)) {
        [void]$body.Append('<w:p/>')
        continue
    }

    # Default: body paragraph with inline formatting
    [void]$body.Append((Para-Body $line))
}
if ($null -ne $tableRows) { $tableRows = Flush-Table $tableRows $body }
if ($inCode -and $codeLines.Count) {
    foreach ($cl in $codeLines) { [void]$body.Append((Para-CodeLine $cl)) }
}

# --------------------------------------------------------------------------
# Assemble document.xml + scaffold (numbering, styles)
# --------------------------------------------------------------------------
$documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
$($body.ToString())
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>
"@

$numberingXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u25E6"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u25AA"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1080" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
'@

$stylesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-CA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>
'@

$contentTypesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>
'@

$rootRelsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
'@

$docRelsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>
'@

# --------------------------------------------------------------------------
# Zip into a .docx
# --------------------------------------------------------------------------
$tmp = [IO.Path]::GetTempFileName() + '.docx'
if (Test-Path $tmp) { Remove-Item $tmp -Force }
$zip = [IO.Compression.ZipFile]::Open($tmp, 'Create')
try {
    function Add-Entry { param($Z, [string]$N, [string]$C)
        $e = $Z.CreateEntry($N, [IO.Compression.CompressionLevel]::Optimal)
        $w = New-Object IO.StreamWriter($e.Open(), [Text.UTF8Encoding]::new($false))
        $w.Write($C); $w.Dispose()
    }
    Add-Entry $zip '[Content_Types].xml'         $contentTypesXml
    Add-Entry $zip '_rels/.rels'                 $rootRelsXml
    Add-Entry $zip 'word/document.xml'           $documentXml
    Add-Entry $zip 'word/styles.xml'             $stylesXml
    Add-Entry $zip 'word/numbering.xml'          $numberingXml
    Add-Entry $zip 'word/_rels/document.xml.rels' $docRelsXml
} finally { $zip.Dispose() }

if (Test-Path $Dest) { Remove-Item $Dest -Force }
Move-Item -Path $tmp -Destination $Dest -Force

Write-Host "Wrote: $Dest"
Write-Host "Size:  $((Get-Item $Dest).Length) bytes"
