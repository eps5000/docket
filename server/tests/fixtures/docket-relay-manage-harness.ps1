# Drives tools/docket-relay/manage.ps1 with every Task Scheduler and process call
# replaced by a function below, so a test can never touch a real task or process.
# The scenario is a JSON file; each replaced call that changes anything is written down.
param([string]$Do, [string]$Want = 'Stopped')

$script:scenario = Get-Content -LiteralPath $env:MANAGE_SCENARIO -Raw | ConvertFrom-Json
$script:sleeps = 0

function Write-Call([string]$Name, $Arguments) {
  $text = (@($Arguments) | ForEach-Object { [string]$_ }) -join ' '
  Add-Content -LiteralPath $env:MANAGE_CALLS -Value "$Name $text"
}

function Set-TaskState([string]$State) {
  foreach ($task in @($script:scenario.tasks)) { if ($task) { $task.State = $State } }
}

function Get-ScheduledTask {
  if ($script:scenario.taskReadFails) { throw 'task service unavailable' }
  foreach ($task in @($script:scenario.tasks)) { if ($task) { $task } }
}

function Disable-ScheduledTask { Write-Call 'Disable-ScheduledTask' $args; Set-TaskState 'Disabled' }

function Unregister-ScheduledTask {
  Write-Call 'Unregister-ScheduledTask' $args
  $script:scenario.tasks = @()
}

# These must never be called. A call is written down so that a test fails.
function Stop-ScheduledTask { Write-Call 'Stop-ScheduledTask' $args }
function Stop-Process { Write-Call 'Stop-Process' $args }

function Get-CimInstance {
  if ($script:scenario.processReadFails) { throw 'process list unavailable' }
  $filter = ''
  for ($i = 0; $i -lt $args.Count - 1; $i += 1) {
    if ([string]$args[$i] -eq '-Filter') { $filter = [string]$args[$i + 1] }
  }
  $id = [int]($filter -replace '\D', '')
  foreach ($process in @($script:scenario.processes)) {
    if ($process -and (-not $filter -or [int]$process.ProcessId -eq $id)) {
      [pscustomobject]@{
        Name           = $process.Name
        ProcessId      = $process.ProcessId
        ParentProcessId = 1
        ExecutablePath = $process.ExecutablePath
        CommandLine    = $process.CommandLine
        CreationDate   = if ($null -ne $process.creation_ms) {
          [DateTimeOffset]::FromUnixTimeMilliseconds([long]$process.creation_ms).UtcDateTime
        } else { $null }
      }
    }
  }
}

# Each wait can let the relay and its task finish, after `exitAfterSleeps` of them.
function Start-Sleep {
  Write-Call 'Start-Sleep' $args
  $script:sleeps += 1
  if ($null -ne $script:scenario.exitAfterSleeps -and
    $script:sleeps -ge [int]$script:scenario.exitAfterSleeps) {
    $script:scenario.processes = @()
    foreach ($task in @($script:scenario.tasks)) {
      if ($task -and $task.State -eq 'Running') { $task.State = 'Ready' }
    }
  }
}

function New-ScheduledTaskAction { Write-Call 'New-ScheduledTaskAction' $args; 'action' }
function New-ScheduledTaskTrigger { Write-Call 'New-ScheduledTaskTrigger' $args; 'trigger' }
function New-ScheduledTaskPrincipal { Write-Call 'New-ScheduledTaskPrincipal' $args; 'principal' }
function New-ScheduledTaskSettingsSet { Write-Call 'New-ScheduledTaskSettingsSet' $args; 'settings' }
function Register-ScheduledTask { Write-Call 'Register-ScheduledTask' $args }

if ($script:scenario.removeFails) {
  function Remove-Item { Write-Call 'Remove-Item' $args }
}

. $env:MANAGE_SCRIPT

$result = Invoke-RelayAction -Do $Do -Want $Want -NodeGiven $env:MANAGE_NODE `
  -Name 'Docket Relay Test Harness'
exit ([int]($result | Select-Object -Last 1))
