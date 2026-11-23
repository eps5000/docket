# Installs, stops, disables, verifies and removes the docket-sync Scheduled
# Task. Every step that claims something proves it, and a failed proof exits 1.
#
#   manage.ps1 -Action Install    Copy the tool and register the task. Does not start it.
#   manage.ps1 -Action Stop       Ask the collector to stop, wait, then prove it
#   manage.ps1 -Action Disable    Stop it, disable the task, then prove it
#   manage.ps1 -Action Verify -Expect Stopped|Disabled|Removed
#   manage.ps1 -Action Remove     Stop, unregister, then delete only the known files
#
# It never kills a process and never deletes recursively. The collector is identified
# only by the PID it recorded at start, with that process's start time, executable
# and script path. Any other process is neither touched nor counted.
param(
  [ValidateSet('Install', 'Stop', 'Disable', 'Verify', 'Remove')][string]$Action,
  [ValidateSet('Stopped', 'Disabled', 'Removed')][string]$Expect = 'Stopped',
  [string]$Node,
  [string]$TaskName = 'Docket Sync'
)

$script:AppFiles = @('docket-sync.mjs', 'launch.ps1', 'manage.ps1', 'README.md')
$script:LibFiles = @('docket.mjs', 'gh.mjs', 'github.mjs', 'runner.mjs', 'store.mjs')
# A new source file is added here too, so Install copies it and Remove knows it.
$script:SourceFiles = @('github.mjs', 'usage.mjs')
$script:StateFiles = @('state.json', 'sync.log', 'sync.log.1', 'instance.json', 'sync.sock')
$script:StatePattern = '^(state\.json\.corrupt-\d+|(state|instance)\.json\.\d+\.tmp)$'
# How far the recorded start may be from the one Windows reports.
$script:StartToleranceMs = 60000
# A child gh.exe ends by its own timeout.
$script:ChildTimeoutSeconds = 30

function Write-Line([string]$Text) { [Console]::Out.WriteLine($Text) }

function Get-SyncPath {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
  $root = Join-Path $env:LOCALAPPDATA 'docket-sync'
  $app = Join-Path $root 'app'
  return @{
    Root     = $root
    App      = $app
    Lib      = Join-Path $app 'lib'
    Sources  = Join-Path $app 'sources'
    Sync     = Join-Path $app 'docket-sync.mjs'
    Launcher = Join-Path $app 'launch.ps1'
    Instance = Join-Path $root 'instance.json'
  }
}

# True only when $Path appears as a whole argument, so `...\app2\x` never matches `...\app\x`.
function Test-HasExactPath([string]$CommandLine, [string]$Path) {
  if ([string]::IsNullOrEmpty($CommandLine) -or [string]::IsNullOrEmpty($Path)) { return $false }
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

# What the collector recorded at start, or $null. Throws if the file can't be read.
function Read-SyncRecord($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.Instance)) { return $null }
  $record = Get-Content -LiteralPath $Paths.Instance -Raw -ErrorAction Stop | ConvertFrom-Json
  if ([int]$record.pid -le 0) { throw 'instance.json has no PID.' }
  return $record
}

# True only for the very process that wrote the record. A reused PID, or a process
# whose details can't be read, is not the collector.
function Test-SyncAlive($Record) {
  if ($null -eq $Record) { return $false }
  $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$Record.pid)" -ErrorAction Stop
  if (-not $p -or -not $p.CreationDate -or -not $p.ExecutablePath) { return $false }
  $started = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
  return ([string]$p.ExecutablePath -ieq [string]$Record.exe) -and
    ([Math]::Abs($started - [long]$Record.started_ms) -le $script:StartToleranceMs) -and
    (Test-HasExactPath ([string]$p.CommandLine) ([string]$Record.script))
}

function Get-SyncTask([string]$Name) {
  return @(Get-ScheduledTask -ErrorAction Stop |
      Where-Object { $_.TaskName -eq $Name -and $_.TaskPath -eq '\' })
}

function Test-TaskBusy([string]$Name) {
  $task = @(Get-SyncTask $Name)
  return $task.Count -gt 0 -and ([string]$task[0].State) -in @('Running', 'Queued')
}

function Invoke-Verify([string]$Want, $Paths, [string]$Name) {
  $failures = New-Object System.Collections.ArrayList
  $taskText = 'unknown'
  try {
    $task = @(Get-SyncTask $Name)
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
    $record = Read-SyncRecord $Paths
    if (Test-SyncAlive $record) { [void]$failures.Add("the collector is still running (PID $($record.pid))") }
  } catch {
    [void]$failures.Add("could not check the collector: $($_.Exception.Message)")
  }
  if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Line "FAILED: $failure" }
    return 1
  }
  Write-Line "PROVEN: task $taskText (expected $Want); the recorded collector is not running."
  return 0
}

# The graceful pipe command, then wait. If it doesn't work, report it and change nothing else.
function Stop-Sync($Paths, [string]$Name, [string]$NodePath) {
  $record = Read-SyncRecord $Paths
  if ($NodePath -and (Test-Path -LiteralPath $Paths.Sync)) {
    $env:DOCKET_SYNC_HOME = $Paths.Root
    & $NodePath $Paths.Sync stop | ForEach-Object { Write-Line ([string]$_) }
    if ($LASTEXITCODE -ne 0) {
      Write-Line "FAILED: the collector did not stop (exit $LASTEXITCODE). Nothing else was changed."
      return 1
    }
  }
  for ($i = 0; ($i -lt 60) -and ((Test-SyncAlive $record) -or (Test-TaskBusy $Name)); $i += 1) {
    Start-Sleep -Milliseconds 500
  }
  if ((Test-SyncAlive $record) -or (Test-TaskBusy $Name)) {
    Write-Line 'FAILED: the collector or its task did not exit in time. Nothing else was changed.'
    return 1
  }
  if ($record) { Start-Sleep -Seconds $script:ChildTimeoutSeconds }
  return 0
}

function Resolve-NodePath([string]$Given) {
  if ($Given) { return $Given }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

# True when something exists at $Path that Install must not write through: a link or
# other reparse point, even a broken one, or a file where a folder belongs or the reverse.
function Test-UnsafeEntry([string]$Path, [bool]$IsFolder) {
  try {
    $attributes = [IO.File]::GetAttributes($Path)
  } catch [IO.FileNotFoundException] {
    return $false
  } catch [IO.DirectoryNotFoundException] {
    return $false
  }
  return $attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
    ($attributes.HasFlag([IO.FileAttributes]::Directory) -ne $IsFolder)
}

# The first unsafe folder, or else every unsafe destination file.
function Get-UnsafeInstallEntry($Paths) {
  foreach ($dir in @($Paths.Root, $Paths.App, $Paths.Lib, $Paths.Sources)) {
    if (Test-UnsafeEntry $dir $true) { return $dir }
  }
  $files = @($script:AppFiles | ForEach-Object { Join-Path $Paths.App $_ }) +
    @($script:LibFiles | ForEach-Object { Join-Path $Paths.Lib $_ }) +
    @($script:SourceFiles | ForEach-Object { Join-Path $Paths.Sources $_ })
  return $files | Where-Object { Test-UnsafeEntry $_ $false }
}

function Invoke-Install($Paths, [string]$Name, [string]$NodePath) {
  if (-not $NodePath) { Write-Line 'FAILED: Node was not found.'; return 1 }
  if ($PSScriptRoot.TrimEnd('\', '/') -ieq $Paths.App.TrimEnd('\', '/')) {
    Write-Line 'FAILED: run Install from a checkout of the repository, not the installed copy.'
    return 1
  }
  $unsafe = @(Get-UnsafeInstallEntry $Paths)
  if ($unsafe.Count -gt 0) {
    Write-Line 'FAILED: Install changed nothing. These are links or the wrong type:'
    foreach ($entry in $unsafe) { Write-Line "  $entry" }
    return 1
  }
  if ((Invoke-Verify 'Stopped' $Paths $Name) -ne 0) {
    Write-Line 'FAILED: stop the collector before installing over it.'
    return 1
  }
  New-Item -ItemType Directory -Force -Path $Paths.Lib | Out-Null
  New-Item -ItemType Directory -Force -Path $Paths.Sources | Out-Null
  foreach ($file in $script:AppFiles) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $Paths.App -Force -ErrorAction Stop
  }
  foreach ($file in $script:LibFiles) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'lib') $file) -Destination $Paths.Lib -Force -ErrorAction Stop
  }
  foreach ($file in $script:SourceFiles) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'sources') $file) -Destination $Paths.Sources -Force -ErrorAction Stop
  }
  $powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass " +
    "-File `"$($Paths.Launcher)`" -Node `"$NodePath`""
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $Paths.App
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  # Interactive, so the user's gh login is reachable. Limited: no elevation.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -TaskPath '\' -Action $taskAction -Trigger $trigger `
    -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  Write-Line "Installed to $($Paths.App) and registered '$Name'. It has not been started."
  return 0
}

# Sorts a folder's entries into known files, and anything that must be left alone.
function Read-Folder([string]$Dir, [string[]]$Files, [string]$Pattern, [string[]]$SubDirs, $Known, $Unexpected) {
  foreach ($entry in @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction Stop)) {
    $isLink = [bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
      [void]$Unexpected.Add($entry.FullName)
    } elseif ($entry.PSIsContainer) {
      if ($entry.Name -notin $SubDirs) { [void]$Unexpected.Add($entry.FullName) }
    } elseif ($entry.Name -in $Files -or ($Pattern -and $entry.Name -match $Pattern)) {
      [void]$Known.Add($entry.FullName)
    } else {
      [void]$Unexpected.Add($entry.FullName)
    }
  }
}

function Remove-KnownFiles($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.Root)) {
    Write-Line "PROVEN: removed the task; $($Paths.Root) is absent."
    return 0
  }
  $known = New-Object System.Collections.ArrayList
  $unexpected = New-Object System.Collections.ArrayList
  if ((Get-Item -LiteralPath $Paths.Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    [void]$unexpected.Add($Paths.Root)
  } else {
    Read-Folder $Paths.Root $script:StateFiles $script:StatePattern @('app') $known $unexpected
    if ((Test-Path -LiteralPath $Paths.App) -and $unexpected -notcontains $Paths.App) {
      Read-Folder $Paths.App $script:AppFiles '' @('lib', 'sources') $known $unexpected
      if ((Test-Path -LiteralPath $Paths.Lib) -and $unexpected -notcontains $Paths.Lib) {
        Read-Folder $Paths.Lib $script:LibFiles '' @() $known $unexpected
      }
      if ((Test-Path -LiteralPath $Paths.Sources) -and $unexpected -notcontains $Paths.Sources) {
        Read-Folder $Paths.Sources $script:SourceFiles '' @() $known $unexpected
      }
    }
  }
  if ($unexpected.Count -gt 0) {
    Write-Line 'FAILED: the task is removed, but these are not known collector files, so no file was deleted:'
    foreach ($entry in $unexpected) { Write-Line "  $entry" }
    return 1
  }
  Set-Location -LiteralPath (Split-Path -Parent $Paths.Root)
  try {
    foreach ($file in $known) { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
    foreach ($dir in @($Paths.Lib, $Paths.Sources, $Paths.App, $Paths.Root)) {
      if (Test-Path -LiteralPath $dir) { [IO.Directory]::Delete($dir, $false) }
    }
  } catch {
    Write-Line "FAILED: could not remove all of $($Paths.Root): $($_.Exception.Message)"
    foreach ($file in $known) {
      if (Test-Path -LiteralPath $file) { Write-Line "  still there: $file" }
    }
    return 1
  }
  Write-Line "PROVEN: removed the task and $($Paths.Root)."
  return 0
}

function Invoke-Remove($Paths, [string]$Name, [string]$NodePath) {
  if ((Stop-Sync $Paths $Name $NodePath) -ne 0) {
    Write-Line 'FAILED: nothing was removed.'
    return 1
  }
  if ((Invoke-Verify 'Stopped' $Paths $Name) -ne 0) {
    Write-Line 'FAILED: nothing was removed.'
    return 1
  }
  if (@(Get-SyncTask $Name).Count -gt 0) {
    Unregister-ScheduledTask -TaskName $Name -TaskPath '\' -Confirm:$false -ErrorAction Stop
  }
  if ((Invoke-Verify 'Removed' $Paths $Name) -ne 0) {
    Write-Line 'FAILED: the folder was not removed.'
    return 1
  }
  return (Remove-KnownFiles $Paths)
}

function Invoke-SyncAction {
  param([string]$Do, [string]$Want, [string]$NodeGiven, [string]$Name)
  try {
    $paths = Get-SyncPath
    $nodePath = Resolve-NodePath $NodeGiven
    switch ($Do) {
      'Install' { return (Invoke-Install $paths $Name $nodePath) }
      'Verify' { return (Invoke-Verify $Want $paths $Name) }
      'Stop' {
        if ((Stop-Sync $paths $Name $nodePath) -ne 0) { return 1 }
        return (Invoke-Verify 'Stopped' $paths $Name)
      }
      'Disable' {
        if (@(Get-SyncTask $Name).Count -eq 0) {
          Write-Line 'FAILED: the task does not exist, so it was not disabled.'
          return 1
        }
        if ((Stop-Sync $paths $Name $nodePath) -ne 0) { return 1 }
        Disable-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop | Out-Null
        return (Invoke-Verify 'Disabled' $paths $Name)
      }
      'Remove' { return (Invoke-Remove $paths $Name $nodePath) }
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
  $result = Invoke-SyncAction -Do $Action -Want $Expect -NodeGiven $Node -Name $TaskName
  exit ([int]($result | Select-Object -Last 1))
}
