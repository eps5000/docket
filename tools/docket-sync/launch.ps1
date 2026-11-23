# Runs docket-sync for the Scheduled Task and returns Node's exit code, so Task
# Scheduler can see it. It holds no logic of its own.
param(
  [Parameter(Mandatory = $true)][string]$Node
)

$sync = Join-Path $PSScriptRoot 'docket-sync.mjs'
try {
  & $Node $sync start
  $code = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("docket-sync launcher could not run Node: $($_.Exception.Message)")
  exit 1
}
if ($null -eq $code) { exit 1 }
exit $code
