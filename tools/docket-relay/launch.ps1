# Runs the relay for the Scheduled Task and returns Node's exit code, so Task
# Scheduler can see it. It holds no logic of its own.
param(
  [Parameter(Mandatory = $true)][string]$Node
)

$relay = Join-Path $PSScriptRoot 'docket-relay.mjs'
try {
  & $Node $relay start
  $code = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("docket-relay launcher could not run Node: $($_.Exception.Message)")
  exit 1
}
if ($null -eq $code) { exit 1 }
exit $code
