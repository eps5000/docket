# Drives tools/docket-relay/manage.ps1 with every Task Scheduler, process and
# CIM call replaced by a function below, so a test can never touch a real task
# or process. The scenario is a JSON file; each replaced call is written down.
param([string]$Do, [string]$Want = 'Stopped')

$script:scenario = Get-Content -LiteralPath $env:MANAGE_SCENARIO -Raw | ConvertFrom-Json

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

function Stop-ScheduledTask {
  Write-Call 'Stop-ScheduledTask' $args
  # Stopping an instance doesn't re-enable a disabled task.
  foreach ($task in @($script:scenario.tasks)) {
    if ($task -and $task.State -ne 'Disabled') { $task.State = 'Ready' }
  }
  if ($script:scenario.stopTaskClearsProcesses) { $script:scenario.processes = @() }
}

function Disable-ScheduledTask {
  Write-Call 'Disable-ScheduledTask' $args
  Set-TaskState 'Disabled'
}

function Unregister-ScheduledTask {
  Write-Call 'Unregister-ScheduledTask' $args
  $script:scenario.tasks = @()
}

function Get-CimInstance {
  if ($script:scenario.processReadFails) { throw 'process list unavailable' }
  foreach ($process in @($script:scenario.processes)) { if ($process) { $process } }
}

function Stop-Process {
  Write-Call 'Stop-Process' $args
  $id = $null
  for ($i = 0; $i -lt $args.Count - 1; $i += 1) {
    if ([string]$args[$i] -eq '-Id') { $id = [int]$args[$i + 1] }
  }
  $script:scenario.processes = @(@($script:scenario.processes) |
      Where-Object { $_ -and [int]$_.ProcessId -ne $id })
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
  -Name 'Docket Relay Test Harness' -ForceStop ($env:MANAGE_FORCE -eq '1')
exit ([int]($result | Select-Object -Last 1))
