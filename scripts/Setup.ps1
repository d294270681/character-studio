[CmdletBinding()]
param(
    [ValidateSet('Check', 'DryRun', 'Install')][string]$Mode = 'Check',
    [string[]]$ReuseModels = @(),
    [string[]]$AcceptLicense = @(),
    [switch]$VerifyExisting,
    [switch]$IncludeLegacy,
    [switch]$ModelsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$studioRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$studioBootstrapLock = $null
$studioBootstrapLockPath = $null

function Assert-NoLinks([string]$LiteralPath) {
    $checkPath = [IO.Path]::GetFullPath($LiteralPath)
    while ($checkPath) {
        if (Test-Path -LiteralPath $checkPath) {
            $item = Get-Item -LiteralPath $checkPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point refused: $checkPath" }
        }
        $parent = [IO.Directory]::GetParent($checkPath)
        if (!$parent) { break }
        $checkPath = $parent.FullName
    }
}

function Assert-TreeNoLinks([string]$LiteralPath) {
    Assert-NoLinks $LiteralPath
    if (!(Test-Path -LiteralPath $LiteralPath -PathType Container)) { return }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($LiteralPath)
    while ($pending.Count) {
        $directory = [IO.DirectoryInfo]::new($pending.Pop())
        foreach ($item in $directory.EnumerateFileSystemInfos()) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point refused: $($item.FullName)" }
            if ($item.Attributes -band [IO.FileAttributes]::Directory) { $pending.Push($item.FullName) }
        }
    }
}

try {
    Assert-NoLinks $studioRoot
    $studioLock = Get-Content -LiteralPath (Join-Path $studioRoot 'runtime.lock.json') -Raw | ConvertFrom-Json
    $studioModels = Get-Content -LiteralPath (Join-Path $studioRoot 'models.manifest.json') -Raw | ConvertFrom-Json
    $studioArgs = @((Join-Path $PSScriptRoot 'setup_env.py'), ('--' + $Mode.ToLowerInvariant().Replace('dryrun', 'dry-run')))
    foreach ($entry in $ReuseModels) { $studioArgs += @('--reuse-models', $entry) }
    foreach ($entry in $AcceptLicense) { $studioArgs += @('--accept-license', $entry) }
    if ($VerifyExisting) { $studioArgs += '--verify-existing' }
    if ($IncludeLegacy) { $studioArgs += '--include-legacy' }
    if ($ModelsOnly) { $studioArgs += '--models-only' }
    $studioPython = $null
    foreach ($candidate in @((Join-Path $studioRoot '.venv\Scripts\python.exe'), (Join-Path $studioRoot 'runtime\bootstrap-python\python.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { Assert-NoLinks $candidate; $studioPython = $candidate; break }
    }
    if (!$studioPython) {
        $command = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($command -and $command.Source -notmatch '\\WindowsApps\\') {
            & $command.Source -I -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0) { $studioPython = $command.Source }
        }
    }
    if ($Mode -ne 'Install') {
        if ($studioPython) { & $studioPython -I -S -B @studioArgs; exit $LASTEXITCODE }
        $selected = @($studioModels.models | Where-Object { $_.active -or ($IncludeLegacy -and $_.scope -eq 'legacy') })
        Write-Output ('Read-only preflight: Windows x64 required; {0} model files, {1:N2} GiB before reuse.' -f $selected.Count, (($selected | Measure-Object bytes -Sum).Sum / 1GB))
        Write-Output 'Python 3.10+ was not found; detailed no-write checks need Python, or use -Mode Install to bootstrap the pinned local runtime.'
        Write-Output 'No files written, no network request made. License IDs:'
        $selected | Where-Object requires_acceptance | Select-Object -ExpandProperty license_id -Unique
        exit 2
    }
    if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 is required.' }
    foreach ($relative in @('runtime', '.venv', 'cache', 'electron\node_modules', 'electron\ui')) { Assert-TreeNoLinks (Join-Path $studioRoot $relative) }
    if (!$ModelsOnly -and !(Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows before full setup.' }
    if (!(Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)) { throw 'NVIDIA driver/nvidia-smi missing.' }
    # With a usable interpreter, finish the entire model/disk/driver preflight before bootstrap.
    if ($studioPython) {
        $preflightArgs = @($studioArgs)
        $preflightArgs[1] = '--check'
        $preflightArgs += @('--verify-existing', '--require-license')
        & $studioPython -I -S -B @preflightArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    # On a clean machine, require explicit agreement before any bootstrap downloads.
    # Existing file reuse is handled by setup_env; supplying a model directory does not accept a license.
    $selected = @($studioModels.models | Where-Object { $_.active -or ($IncludeLegacy -and $_.scope -eq 'legacy') })
    foreach ($lic in @($selected | Where-Object requires_acceptance | Select-Object -ExpandProperty license_id -Unique)) {
        if (!$studioPython -and $AcceptLicense -notcontains $lic) { throw "Read docs/MODELS.md and pass -AcceptLicense $lic before bootstrap, or run a preflight with Python first." }
    }
    $lockDirectory = Join-Path $studioRoot '.setup-state'
    Assert-NoLinks $lockDirectory
    [IO.Directory]::CreateDirectory($lockDirectory) | Out-Null
    $studioBootstrapLockPath = Join-Path $lockDirectory 'bootstrap.lock'
    Assert-NoLinks $studioBootstrapLockPath
    try { $studioBootstrapLock = [IO.File]::Open($studioBootstrapLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw 'Another setup may be running. Confirm it has ended before removing .setup-state/bootstrap.lock.' }
    $studioUv = Join-Path $studioRoot 'runtime\bootstrap\uv.exe'
    if (!$ModelsOnly -or !$studioPython) {
        Assert-NoLinks (Join-Path $studioRoot 'runtime')
        Assert-NoLinks (Join-Path $studioRoot 'cache')
        if (!(Test-Path -LiteralPath $studioUv -PathType Leaf)) {
            $bootstrapDir = Join-Path $studioRoot 'runtime\bootstrap'
            if (Test-Path -LiteralPath $bootstrapDir) { throw 'Incomplete bootstrap directory preserved. Inspect/move it before retry.' }
            $archive = Join-Path $studioRoot 'cache\downloads\uv.zip'
            $partial = $archive + '.part'
            Assert-NoLinks $archive
            Assert-NoLinks $partial
            [IO.Directory]::CreateDirectory((Split-Path -Parent $archive)) | Out-Null
            if (!(Test-Path -LiteralPath $archive)) {
                # uv is a small bootstrap archive; safe full retry uses a separate partial file.
                $downloaded = $false
                for ($attempt = 0; $attempt -lt 3; $attempt++) {
                    try {
                        Invoke-WebRequest -UseBasicParsing -Uri $studioLock.uv.url -OutFile $partial
                        if ((Get-Item -LiteralPath $partial).Length -ne $studioLock.uv.bytes -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $studioLock.uv.sha256) { throw 'uv bootstrap checksum mismatch' }
                        Move-Item -LiteralPath $partial -Destination $archive
                        $downloaded = $true
                        break
                    } catch { if ($attempt -eq 2) { throw 'Bootstrap download failed after 3 attempts; no executable installed. Retry Setup.cmd.' }; Start-Sleep -Seconds (2 + $attempt) }
                }
                if (!$downloaded) { throw 'Bootstrap unavailable' }
            }
            if ((Get-Item -LiteralPath $archive).Length -ne $studioLock.uv.bytes -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $studioLock.uv.sha256) { throw 'Existing bootstrap archive mismatch; preserved.' }
            $stagingDir = $bootstrapDir + '.extracting'
            Assert-NoLinks $stagingDir
            if (Test-Path -LiteralPath $stagingDir) { throw 'Interrupted bootstrap extraction preserved; inspect/move before retry.' }
            # Official checksum-authenticated uv zip; only copy the exact root executable.
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                $entry = $zip.GetEntry('uv.exe')
                if (!$entry) { throw 'Unexpected uv archive layout' }
                [IO.Directory]::CreateDirectory($stagingDir) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stagingDir 'uv.exe'), $false)
            } finally { $zip.Dispose() }
            Move-Item -LiteralPath $stagingDir -Destination $bootstrapDir
        }
        $uvVersion = & $studioUv --version
        if ($LASTEXITCODE -ne 0 -or $uvVersion -notmatch ('^uv ' + [regex]::Escape($studioLock.uv.version) + '(\s|$)')) { throw 'Local uv executable version differs from the pin; preserved.' }
        $env:UV_PYTHON_INSTALL_DIR = Join-Path $studioRoot 'runtime\python'
        $env:UV_CACHE_DIR = Join-Path $studioRoot 'cache\uv'
        $env:UV_NO_CONFIG = '1'
        $env:UV_PYTHON_PREFERENCE = 'only-managed'
        & $studioUv python install $studioLock.python_version --no-bin
        if ($LASTEXITCODE -ne 0) { throw 'Pinned managed Python install failed.' }
        $studioPython = (& $studioUv python find --managed-python $studioLock.python_version | Select-Object -Last 1)
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $studioPython)) { throw 'Pinned managed Python unavailable.' }
        $studioArgs += @('--uv', $studioUv)
    }
    & $studioPython -I -S -B @studioArgs
    exit $LASTEXITCODE
} catch {
    # Do not print web exception details, signed URLs, request headers or environment variables.
    $safeMessage = if ($_.Exception -is [Net.WebException]) { 'Network request failed; retry later.' } else { $_.Exception.Message }
    Write-Error ('Setup failed: ' + $safeMessage + ' Existing project data is preserved. See README troubleshooting or rerun -Mode Check.')
    exit 1
} finally {
    if ($studioBootstrapLock) {
        $studioBootstrapLock.Dispose()
        [IO.File]::Delete($studioBootstrapLockPath)
    }
}
