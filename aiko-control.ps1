# Aiko control window: turn her Discord text bot and her voice on or off.
# Start it with "Aiko Control.cmd" (double-click). Every button runs `pnpm dev ...` in this folder.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Repo = $PSScriptRoot
$VoiceServices = 'asr turn voice-node'
$LogFile = Join-Path $env:TEMP "aiko-control-$PID.log"

function Read-SharedText([string]$path) {
    if (-not (Test-Path $path)) { return @() }
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sr = New-Object System.IO.StreamReader($fs, [Text.Encoding]::UTF8)
        try { return @($sr.ReadToEnd() -split "`r?`n") } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
}

$form = New-Object Windows.Forms.Form
$form.Text = 'Aiko'
$form.ClientSize = New-Object Drawing.Size(360, 335)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Segoe UI', 10)

function New-Label($text, $y) {
    $l = New-Object Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object Drawing.Point(16, $y); $l.AutoSize = $true
    $form.Controls.Add($l); $l
}
function New-Button($text, $x, $y, $w) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object Drawing.Point($x, $y); $b.Size = New-Object Drawing.Size($w, 32)
    $form.Controls.Add($b); $b
}

$textState      = New-Label 'Text bot: checking...' 18
$textButton     = New-Button 'Turn on' 240 12 104
$selfChatState  = New-Label 'Self chat: checking...' 62
$selfChatButton = New-Button 'Turn on' 240 56 104
$voiceState     = New-Label 'Voice: checking...' 106
$voiceButton    = New-Button 'Turn on' 240 100 104

$personaLabel = New-Label 'Persona:' 155
$personaBox = New-Object Windows.Forms.ComboBox
$personaBox.Location = New-Object Drawing.Point(82, 151)
$personaBox.Size = New-Object Drawing.Size(150, 28)
$personaBox.DropDownStyle = 'DropDownList'
$form.Controls.Add($personaBox)
$personaButton = New-Button 'Apply' 240 149 104

$stopButton    = New-Button 'Stop everything' 16 200 212
$refreshButton = New-Button 'Refresh' 240 200 104
$info = New-Label '' 248
$info.MaximumSize = New-Object Drawing.Size(328, 0)
$info.ForeColor = [Drawing.Color]::DimGray

$script:proc = $null
$script:queue = @()
$script:output = @()
$script:jobKind = ''
$script:problem = ''
$script:silentRefresh = $false
$script:coreUp = $false
$script:textOn = $false
$script:selfChatOn = $false
$script:voiceOn = $false
$script:personaIds = New-Object System.Collections.ArrayList

function Load-Personas() {
    $presetsDir = Join-Path $Repo 'profiles\aiko\presets'
    $activeFile = Join-Path $Repo 'profiles\aiko\persona\.active'
    $activeId = 'kuudere'
    if (Test-Path $activeFile) {
        $lines = Read-SharedText $activeFile | Where-Object { $_.Trim() -ne '' }
        if ($lines.Count -gt 0) { $activeId = $lines[0].Trim() }
    }
    $items = @()
    if (Test-Path $presetsDir) {
        foreach ($dir in Get-ChildItem -Path $presetsDir -Directory) {
            $metaFile = Join-Path $dir.FullName 'preset.json'
            if (Test-Path $metaFile) {
                try {
                    $raw = [string]::Join("`n", (Read-SharedText $metaFile))
                    $meta = $raw | ConvertFrom-Json
                    $pid = $(if ($meta.id) { [string]$meta.id } else { $dir.Name })
                    $label = $(if ($meta.label) { [string]$meta.label } else { $pid })
                    $order = $(if ($null -ne $meta.order) { [int]$meta.order } else { 99 })
                    $items += [PSCustomObject]@{ Id = $pid; Label = $label; Order = $order }
                } catch { }
            }
        }
    }
    $items = @($items | Sort-Object Order, Id)
    $personaBox.Items.Clear()
    [void]$script:personaIds.Clear()
    $selectedIndex = -1
    for ($i = 0; $i -lt $items.Count; $i++) {
        [void]$script:personaIds.Add($items[$i].Id)
        [void]$personaBox.Items.Add($items[$i].Label)
        if ($items[$i].Id -eq $activeId) { $selectedIndex = $i }
    }
    if ($selectedIndex -ge 0) {
        $personaBox.SelectedIndex = $selectedIndex
    } elseif ($personaBox.Items.Count -gt 0) {
        $personaBox.SelectedIndex = 0
    }
    $personaBox.Enabled = ($personaBox.Items.Count -gt 0)
    $personaButton.Enabled = ($personaBox.Items.Count -gt 0)
}

function Set-Busy([bool]$busy, [string]$message) {
    foreach ($b in $textButton, $selfChatButton, $voiceButton, $personaBox, $personaButton, $stopButton, $refreshButton) { $b.Enabled = -not $busy }
    $info.Text = $message
}

function Start-NextCommand() {
    $cmd = $script:queue[0]
    $script:queue = @($script:queue | Select-Object -Skip 1)
    # Run via cmd writing to a file (not a pipe), so detached hostd cannot hang the control window.
    $script:proc = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList @('/c', "chcp 65001 >nul && pnpm dev $cmd > `"$LogFile`" 2>&1") `
        -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
}

function Start-Work([string]$kind, [string[]]$commands, [string]$message, [bool]$silent = $false) {
    $script:silentRefresh = $silent
    if (-not $silent) {
        Set-Busy $true $message
    }
    $script:jobKind = $kind
    $script:queue = @($commands)
    $script:output = @()
    Start-NextCommand
}

function Update-Status([string[]]$lines) {
    $text = ([string]::Join("`n", $lines)) -replace "\x1b\[[0-9;]*[a-zA-Z]", ""
    $coreUp = $text -match '(?m)^core\s+running'
    $script:coreUp = $coreUp
    $script:textOn = $coreUp -and ($text -match '(?m)^platform\.discord\.bot\s+running')
    $script:selfChatOn = $coreUp -and ($text -match '(?m)^platform\.discord\.self\s+running')
    $script:voiceOn = $coreUp -and ($text -match '(?m)^voice-node\s+running') -and ($text -match '(?m)^asr\s+running')
    $textState.Text = 'Text bot: ' + $(if ($script:textOn) { 'ON' } else { 'OFF' })
    $selfChatState.Text = 'Self chat: ' + $(if ($script:selfChatOn) { 'ON' } else { 'OFF' })
    $voiceState.Text = 'Voice: ' + $(if ($script:voiceOn) { 'ON' } else { 'OFF' })
    $textState.ForeColor = $(if ($script:textOn) { [Drawing.Color]::SeaGreen } else { [Drawing.Color]::Firebrick })
    $selfChatState.ForeColor = $(if ($script:selfChatOn) { [Drawing.Color]::SeaGreen } else { [Drawing.Color]::Firebrick })
    $voiceState.ForeColor = $(if ($script:voiceOn) { [Drawing.Color]::SeaGreen } else { [Drawing.Color]::Firebrick })
    $textButton.Text = $(if ($script:textOn) { 'Turn off' } else { 'Turn on' })
    $selfChatButton.Text = $(if ($script:selfChatOn) { 'Turn off' } else { 'Turn on' })
    $voiceButton.Text = $(if ($script:voiceOn) { 'Turn off' } else { 'Turn on' })
    if ($coreUp -and -not $script:textOn -and -not $script:selfChatOn -and -not $script:voiceOn -and $info.Text -eq '') {
        $info.Text = 'Background core is idle — click Stop everything to close it.'
    } elseif ($info.Text -like 'Background core is idle*') {
        $info.Text = ''
    }
}

$textButton.Add_Click({
    if ($script:textOn) {
        if (-not $script:selfChatOn -and -not $script:voiceOn) {
            Start-Work 'action' @('module disable platform.discord.bot -y', 'down') 'Turning text bot off and stopping background core...'
        } else {
            Start-Work 'action' @('module disable platform.discord.bot -y') 'Turning the text bot off...'
        }
    } elseif ($script:selfChatOn) {
        Start-Work 'action' @('module disable platform.discord.self -y', 'module enable platform.discord.bot -y') 'Switching to text bot...'
    } else {
        Start-Work 'action' @('up core', 'module disable platform.discord.self -y', 'module enable platform.discord.bot -y') 'Turning the text bot on...'
    }
})
$selfChatButton.Add_Click({
    if ($script:selfChatOn) {
        if (-not $script:textOn -and -not $script:voiceOn) {
            Start-Work 'action' @('module disable platform.discord.self -y', 'down') 'Turning self chat off and stopping background core...'
        } else {
            Start-Work 'action' @('module disable platform.discord.self -y') 'Turning self chat off...'
        }
    } elseif ($script:textOn) {
        Start-Work 'action' @('module disable platform.discord.bot -y', 'module enable platform.discord.self -y') 'Switching to self chat...'
    } else {
        Start-Work 'action' @('up core', 'module disable platform.discord.bot -y', 'module enable platform.discord.self -y') 'Turning self chat on...'
    }
})
$voiceButton.Add_Click({
    if ($script:voiceOn) {
        if (-not $script:textOn -and -not $script:selfChatOn) {
            Start-Work 'action' @('down') 'Turning voice off and stopping background core...'
        } else {
            Start-Work 'action' @("down $VoiceServices") 'Turning voice off...'
        }
    } else {
        Start-Work 'action' @("up core $VoiceServices") 'Turning voice on (loading her voice takes 1 to 2 minutes)...'
    }
})
$personaButton.Add_Click({
    if ($personaBox.SelectedIndex -lt 0 -or $personaBox.SelectedIndex -ge $script:personaIds.Count) { return }
    $selectedId = [string]$script:personaIds[$personaBox.SelectedIndex]
    $selectedLabel = [string]$personaBox.SelectedItem
    $switchProc = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList @('/c', "chcp 65001 >nul && node scripts/aiko-persona.mjs use `"$selectedId`" > `"$LogFile`" 2>&1") `
        -WorkingDirectory $Repo -WindowStyle Hidden -Wait -PassThru
    $switchOut = @(Read-SharedText $LogFile | Where-Object { $_.Trim() -ne '' })
    if ($switchProc.ExitCode -ne 0) {
        $errMsg = $(if ($switchOut.Count -gt 0) { [string]::Join(' ', $switchOut) } else { "exit code $($switchProc.ExitCode)" })
        $info.Text = "Persona switch failed: $errMsg"
        return
    }
    if ($script:coreUp) {
        Start-Work 'action' @('restart core') "Persona set to $selectedLabel. Restarting core..."
    } else {
        $info.Text = "Persona set to $selectedLabel. Turn on Text bot, Self chat, or Voice to use it."
    }
})
$stopButton.Add_Click({ Start-Work 'action' @('down') 'Stopping everything...' })
$refreshButton.Add_Click({ Start-Work 'status' @('status') 'Checking...' })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if ($null -eq $script:proc -or -not $script:proc.HasExited) { return }
    $script:output += Read-SharedText $LogFile
    $script:proc.Dispose()
    $script:proc = $null
    if ($script:queue.Count -gt 0) {
        Start-NextCommand
        return
    }
    if ($script:jobKind -eq 'status') {
        if (-not $script:silentRefresh) {
            Set-Busy $false $script:problem
            $script:problem = ''
        } elseif ($script:problem -eq '' -and $info.Text -eq 'Checking...') {
            $info.Text = ''
        }
        Update-Status $script:output
        $script:silentRefresh = $false
    } else {
        $failed = $script:output | Where-Object { $_ -match 'ELIFECYCLE|Error' } | Select-Object -First 1
        $script:problem = $(if ($failed) { "Problem: $failed" } else { '' })
        Start-Work 'status' @('status') 'Done. Checking...'
    }
})
$timer.Start()

$autoRefreshTimer = New-Object Windows.Forms.Timer
$autoRefreshTimer.Interval = 15000
$autoRefreshTimer.Add_Tick({
    if ($null -eq $script:proc -and $script:queue.Count -eq 0) {
        Start-Work 'status' @('status') '' $true
    }
})
$autoRefreshTimer.Start()

Load-Personas
$form.Add_Shown({ Start-Work 'status' @('status') 'Checking...' })
[void]$form.ShowDialog()
$autoRefreshTimer.Stop()
$timer.Stop()
if ($null -ne $script:proc -and -not $script:proc.HasExited) { $script:proc.Kill() }
Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
