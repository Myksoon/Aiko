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
$form.ClientSize = New-Object Drawing.Size(340, 275)
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

$textState     = New-Label 'Text bot: checking...' 18
$textButton    = New-Button 'Turn on' 220 12 104
$selfChatState = New-Label 'Self chat: checking...' 62
$selfChatButton = New-Button 'Turn on' 220 56 104
$voiceState    = New-Label 'Voice: checking...' 106
$voiceButton   = New-Button 'Turn on' 220 100 104
$stopButton    = New-Button 'Stop everything' 16 150 180
$refreshButton = New-Button 'Refresh' 220 150 104
$info = New-Label '' 198
$info.MaximumSize = New-Object Drawing.Size(308, 0)
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

function Set-Busy([bool]$busy, [string]$message) {
    foreach ($b in $textButton, $selfChatButton, $voiceButton, $stopButton, $refreshButton) { $b.Enabled = -not $busy }
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

$form.Add_Shown({ Start-Work 'status' @('status') 'Checking...' })
[void]$form.ShowDialog()
$autoRefreshTimer.Stop()
$timer.Stop()
if ($null -ne $script:proc -and -not $script:proc.HasExited) { $script:proc.Kill() }
Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
