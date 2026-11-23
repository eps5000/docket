# Installs, stops, disables, verifies and removes the docket-relay Scheduled
# Task. Every step that claims something proves it, and a failed proof exits 1.
#
#   manage.ps1 -Action Install    Copy the tool and register the task. Does not start it.
#   manage.ps1 -Action Stop       Stop gracefully, then prove nothing remains
#   manage.ps1 -Action Disable    Disable the task, stop it, then prove it
#   manage.ps1 -Action Verify -Expect Stopped|Disabled|Removed
#   manage.ps1 -Action Remove     Stop, unregister, prove it, delete %LOCALAPPDATA%\docket-relay
#
# It only ever acts on the task named here, on processes whose command line has
# the exact installed path (and their child orca.exe), and on that one folder.
param(
  [ValidateSet('Install', 'Stop', 'Disable', 'Verify', 'Remove')][string]$Action,
  [ValidateSet('Stopped', 'Disabled', 'Removed')][string]$Expect = 'Stopped',
  [string]$Node,
  [string]$TaskName = 'Docket Relay',
  [switch]$Force
)

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }

function Get-RelayPath {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
  $root = Join-Path $env:LOCALAPPDATA 'docket-relay'
  $app = Join-Path $root 'app'
  return @{
    Root     = $root
    App      = $app
    Relay    = Join-Path $app 'docket-relay.mjs'
    Launcher = Join-Path $app 'launch.ps1'
  }
}

# True only when $Path appears as a whole argument, so `...\app2\x` never matches `...\app\x`.
function Test-HasExactPath([string]$CommandLine, [string]$Path) {
  if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
  $edges = @([char]'"', [char]"'", [char]' ')
  $start = 0
  while ($start -lt $CommandLine.Length) {
    $at = $CommandLine.IndexOf($Path, $start, [StringComparison]::OrdinalIgnoreCase)
    if ($at -lt 0) { return $false }
    $end = $at + $Path.Length
    $beforeOk = ($at -eq 0) -or ($edges -contains $CommandLine[$at - 1])
    $afterOk = ($end -eq $CommandLine.Length) -or ($edges -contains $CommandLine[$end])
    if ($beforeOk -and $afterOk) { return $true }
    $start = $at + 1
  }
  return $false
}

# Relay processes, and any node or orca.exe whose command line this user can't read.
function Find-RelayProcess($Paths) {
  $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  $found = New-Object System.Collections.ArrayList
  $relayIds = @{}
  foreach ($p in $all) {
    $name = ([string]$p.Name).ToLowerInvariant()
    if ($name -in @('node.exe', 'node') -and (Test-HasExactPath $p.CommandLine $Paths.Relay)) {
      $relayIds[[string]$p.ProcessId] = $true
      [void]$found.Add([pscustomobject]@{ ProcessId = $p.ProcessId; Role = 'relay node' })
    } elseif ($name -in @('powershell.exe', 'pwsh.exe', 'pwsh') -and
      (Test-HasExactPath $p.CommandLine $Paths.Launcher)) {
      $relayIds[[string]$p.ProcessId] = $true
      [void]$found.Add([pscustomobject]@{ ProcessId = $p.ProcessId; Role = 'launcher' })
    }
  }
  foreach ($p in $all) {
    $name = ([string]$p.Name).ToLowerInvariant()
    $isOrca = $name -in @('orca.exe', 'orca')
    if ($isOrca -and $relayIds.ContainsKey([string]$p.ParentProcessId)) {
      [void]$found.Add([pscustomobject]@{ ProcessId = $p.ProcessId; Role = 'child orca' })
    } elseif ($isOrca -and ([string]$p.CommandLine) -match '(^|\s)--from\s+"?docket-relay"?(\s|$)') {
      [void]$found.Add([pscustomobject]@{ ProcessId = $p.ProcessId; Role = 'orphan orca send' })
    } elseif (($isOrca -or $name -in @('node.exe', 'node')) -and
      [string]::IsNullOrEmpty([string]$p.CommandLine)) {
      [void]$found.Add([pscustomobject]@{ ProcessId = $p.ProcessId; Role = 'unreadable command line' })
    }
  }
  return , $found.ToArray()
}

function Get-RelayTask([string]$Name) {
  return @(Get-ScheduledTask -ErrorAction Stop |
      Where-Object { $_.TaskName -eq $Name -and $_.TaskPath -eq '\' })
}

function Invoke-Verify([string]$Want, $Paths, [string]$Name) {
  $failures = New-Object System.Collections.ArrayList
  $taskText = 'unknown'
  try {
    $task = @(Get-RelayTask $Name)
    if ($task.Count -eq 0) {
      $taskText = 'absent'
      if ($Want -eq 'Disabled') { [void]$failures.Add('the task does not exist, so it is not disabled') }
    } else {
      $state = [string]$task[0].State
      $taskText = $state
      if ($Want -eq 'Removed') { [void]$failures.Add("the task still exists ($state)") }
      if ($Want -eq 'Disabled' -and $state -ne 'Disabled') { [void]$failures.Add("the task is $state") }
      if ($Want -eq 'Stopped' -and $state -in @('Running', 'Queued')) {
        [void]$failures.Add("the task is $state")
      }
    }
  } catch {
    [void]$failures.Add("could not read the task: $($_.Exception.Message)")
  }
  try {
    foreach ($p in (Find-RelayProcess $Paths)) {
      [void]$failures.Add("$($p.Role) is still present (PID $($p.ProcessId))")
    }
  } catch {
    [void]$failures.Add("could not read processes: $($_.Exception.Message)")
  }
  if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Line "FAILED: $failure" }
    return 1
  }
  Write-Line "PROVEN: task $taskText (expected $Want); no relay node, launcher or child orca.exe remains."
  return 0
}

function Stop-RelayProcess($Paths, [string]$Name, [string]$NodePath, [bool]$ForceStop) {
  if ($NodePath -and (Test-Path -LiteralPath $Paths.Relay)) {
    $env:DOCKET_RELAY_HOME = $Paths.Root
    & $NodePath $Paths.Relay stop | ForEach-Object { Write-Line ([string]$_) }
    if ($LASTEXITCODE -ne 0) { Write-Line "Graceful stop failed (exit $LASTEXITCODE)." }
  } else {
    Write-Line 'Graceful stop skipped: Node or the installed relay was not found.'
  }
  # Always, whatever its state says: a disabled task can still have a running instance.
  # A failure here isn't final, because the proof that follows decides.
  if (@(Get-RelayTask $Name).Count -gt 0) {
    try {
      Stop-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
    } catch {
      Write-Line "Stop-ScheduledTask failed: $($_.Exception.Message)"
    }
  }
  if ($ForceStop) {
    foreach ($p in (Find-RelayProcess $Paths)) {
      if ($p.Role -eq 'unreadable command line') { continue }
      Write-Line "Forcing $($p.Role) (PID $($p.ProcessId)) to stop."
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Continue
    }
  }
}

function Resolve-NodePath([string]$Given) {
  if ($Given) { return $Given }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Invoke-Install($Paths, [string]$Name, [string]$NodePath) {
  if (-not $NodePath) { Write-Line 'FAILED: Node was not found.'; return 1 }
  if ($PSScriptRoot.TrimEnd('\', '/') -ieq $Paths.App.TrimEnd('\', '/')) {
    Write-Line 'FAILED: run Install from a checkout of the repository, not the installed copy.'
    return 1
  }
  if ((Invoke-Verify 'Stopped' $Paths $Name) -ne 0) {
    Write-Line 'FAILED: stop the relay before installing over it.'
    return 1
  }
  New-Item -ItemType Directory -Force -Path $Paths.App | Out-Null
  foreach ($file in @('docket-relay.mjs', 'launch.ps1', 'manage.ps1', 'README.md', 'lib')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $Paths.App -Recurse -Force -ErrorAction Stop
  }
  $powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass " +
    "-File `"$($Paths.Launcher)`" -Node `"$NodePath`""
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $Paths.App
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  # Interactive, so Orca stays reachable. Limited: no elevation.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -TaskPath '\' -Action $taskAction -Trigger $trigger `
    -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  Write-Line "Installed to $($Paths.App) and registered '$Name'. It has not been started."
  return 0
}

function Invoke-Remove($Paths, [string]$Name, [string]$NodePath, [bool]$ForceStop) {
  Stop-RelayProcess $Paths $Name $NodePath $ForceStop
  if ((Invoke-Verify 'Stopped' $Paths $Name) -ne 0) {
    Write-Line 'FAILED: nothing was removed.'
    return 1
  }
  if (@(Get-RelayTask $Name).Count -gt 0) {
    Unregister-ScheduledTask -TaskName $Name -TaskPath '\' -Confirm:$false -ErrorAction Stop
  }
  if ((Invoke-Verify 'Removed' $Paths $Name) -ne 0) {
    Write-Line 'FAILED: the folder was not removed.'
    return 1
  }
  if (-not (Test-Path -LiteralPath $Paths.Root)) {
    Write-Line "PROVEN: $($Paths.Root) is absent."
    return 0
  }
  $item = Get-Item -LiteralPath $Paths.Root -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Write-Line "FAILED: $($Paths.Root) is a link, so it was not removed."
    return 1
  }
  Set-Location -LiteralPath (Split-Path -Parent $Paths.Root)
  Remove-Item -LiteralPath $Paths.Root -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable removeErrors
  if (Test-Path -LiteralPath $Paths.Root) {
    Write-Line "FAILED: could not remove all of $($Paths.Root). Still there:"
    Get-ChildItem -LiteralPath $Paths.Root -Recurse -Force -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Line "  $($_.FullName)" }
    foreach ($problem in $removeErrors) { Write-Line "  $($problem.Exception.Message)" }
    return 1
  }
  Write-Line "PROVEN: removed the task and $($Paths.Root)."
  return 0
}

function Invoke-RelayAction {
  param([string]$Do, [string]$Want, [string]$NodeGiven, [string]$Name, [bool]$ForceStop)
  try {
    $paths = Get-RelayPath
    $nodePath = Resolve-NodePath $NodeGiven
    switch ($Do) {
      'Install' { return (Invoke-Install $paths $Name $nodePath) }
      'Verify' { return (Invoke-Verify $Want $paths $Name) }
      'Stop' {
        Stop-RelayProcess $paths $Name $nodePath $ForceStop
        return (Invoke-Verify 'Stopped' $paths $Name)
      }
      'Disable' {
        if (@(Get-RelayTask $Name).Count -eq 0) {
          Write-Line 'FAILED: the task does not exist, so it was not disabled.'
          return 1
        }
        # First, so a restart can't race the stop.
        Disable-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop | Out-Null
        Stop-RelayProcess $paths $Name $nodePath $ForceStop
        return (Invoke-Verify 'Disabled' $paths $Name)
      }
      'Remove' { return (Invoke-Remove $paths $Name $nodePath $ForceStop) }
      default {
        Write-Line 'Use -Action Install, Stop, Disable, Verify or Remove.'
        return 1
      }
    }
  } catch {
    Write-Line "FAILED: $($_.Exception.Message)"
    return 1
  }
}

# Dot-sourcing loads the functions without acting, which is how the tests drive it.
if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-RelayAction -Do $Action -Want $Expect -NodeGiven $Node -Name $TaskName -ForceStop ([bool]$Force)
  exit ([int]($result | Select-Object -Last 1))
}
