param(
    [string]$SourceDirectory = (Join-Path $PSScriptRoot '..\.sidebar-content-src'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\src\ui\sidebar\modules')
)

$ErrorActionPreference = 'Stop'

$targets = @(
    @{
        Source = 'changelog.json'
        Output = 'changelogData.js'
        ExportName = 'ENCODED_CHANGELOG'
    },
    @{
        Source = 'guide.json'
        Output = 'guideData.js'
        ExportName = 'ENCODED_GUIDE'
    },
    @{
        Source = 'acknowledgements.json'
        Output = 'acknowledgementsData.js'
        ExportName = 'ENCODED_ACKNOWLEDGEMENTS'
    }
)

foreach ($target in $targets) {
    $sourcePath = Join-Path $SourceDirectory $target.Source
    $outputPath = Join-Path $OutputDirectory $target.Output
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Missing local source file: $sourcePath"
    }

    $sourceJson = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourcePath
    $compactJson = $sourceJson | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($compactJson))
    $chunks = [regex]::Matches($encoded, '.{1,120}') | ForEach-Object { $_.Value }
    $lines = @(
        "export const $($target.ExportName) = ["
        $chunks | ForEach-Object { "    '$_'," }
        "].join('');"
    )
    Set-Content -LiteralPath $outputPath -Encoding UTF8 -Value $lines
    Write-Output "Generated $outputPath from ignored local source $sourcePath"
}
