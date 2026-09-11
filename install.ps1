# Hermit Console installer for Windows.
#
#   irm https://raw.githubusercontent.com/cloudrevel-lab/hermit/main/install.ps1 | iex
#
# Installs Hermit under $HOME\.hermit (override with HERMIT_HOME). Uses an
# existing Node if one is on PATH, otherwise downloads a private runtime. Adds a
# `hermit` command to your user PATH.

$ErrorActionPreference = 'Stop'

if (-not $env:HERMIT_HOME) { $env:HERMIT_HOME = Join-Path $HOME '.hermit' }
$HermitHome = $env:HERMIT_HOME
if (-not $env:HERMIT_NODE_CHANNEL) { $env:HERMIT_NODE_CHANNEL = 'latest-v22.x' }

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { throw ('error: ' + $m) }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { Die ('unsupported architecture: ' + $env:PROCESSOR_ARCHITECTURE) }
}

function Test-NodeOk([string]$exe) {
  if (-not $exe) { return $false }
  $null = & $exe -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)' 2>$null
  return ($LASTEXITCODE -eq 0)
}

$nodeExe = $null
$npmCmd = $null
$npmCli = $null

$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode -and (Test-NodeOk $systemNode.Source)) {
  $nodeExe = $systemNode.Source
  $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
  if (-not $npmCmd) { Die 'node is on PATH but npm is not' }
  Say ('Using the Node already on PATH (' + (& $nodeExe -v) + ').')
} else {
  $runtime = Join-Path $HermitHome 'runtime'
  $cached = Get-ChildItem -Path $runtime -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cached -and (Test-NodeOk $cached.FullName)) {
    $nodeExe = $cached.FullName
    $npmCli = Join-Path (Split-Path (Split-Path $nodeExe)) 'node_modules/npm/bin/npm-cli.js'
    Say ('Using the Node runtime already installed in ' + $HermitHome + '.')
  } else {
    Say 'No suitable Node found; downloading a private runtime (one-time).'
    $listing = (Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/' + $env:HERMIT_NODE_CHANNEL + '/')).Content
    $match = [regex]::Match($listing, 'node-v[0-9.]+-win-' + $arch + '[.]zip')
    if (-not $match.Success) { Die ('no Node build found for win-' + $arch) }
    $file = $match.Value
    $ver = (($file -replace '^node-','') -replace ('-win-' + $arch + '[.]zip$'),'')
    Say ('  Node ' + $ver + ' (win-' + $arch + ')')
    $tmp = Join-Path $env:TEMP ('hermit-node-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/' + $ver + '/' + $file) -OutFile $zip
    try {
      $shasums = (Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/' + $ver + '/SHASUMS256.txt')).Content
      $line = ($shasums -split "`n" | Where-Object { $_ -match [regex]::Escape($file) } | Select-Object -First 1)
      if ($line) {
        $want = ($line -split '[ ]+')[0].ToUpper()
        $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToUpper()
        if ($want -ne $got) { Die ('checksum mismatch for ' + $file) }
        Say '  checksum ok'
      }
    } catch { }
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Expand-Archive -Path $zip -DestinationPath $runtime -Force
    $nodeDir = Join-Path $runtime ($file -replace '[.]zip$','')
    $nodeExe = Join-Path $nodeDir 'node.exe'
    $npmCli = Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js'
    Remove-Item -Recurse -Force $tmp
    if (-not (Test-Path $nodeExe)) { Die 'Node did not install where expected' }
  }
}

# Installs from npm. Set HERMIT_TARBALL to a tarball URL or path to install a
# specific build instead (for example a GitHub release asset).
if ($env:HERMIT_TARBALL) {
  $spec = $env:HERMIT_TARBALL
} else {
  $spec = 'hermit-console@latest'
}

Say ('Installing Hermit into ' + $HermitHome + ' ...')
New-Item -ItemType Directory -Force -Path $HermitHome | Out-Null
$installLog = Join-Path $HermitHome 'npm-install.log'
if ($npmCli) {
  & $nodeExe $npmCli install --global --prefix $HermitHome --no-fund --no-audit $spec *> $installLog
} else {
  & $npmCmd install --global --prefix $HermitHome --no-fund --no-audit $spec *> $installLog
}
if ($LASTEXITCODE -ne 0) {
  Get-Content $installLog -Tail 15 | ForEach-Object { Write-Host $_ }
  Die ('npm could not install ' + $spec + '; full log: ' + $installLog)
}
Remove-Item -Force $installLog -ErrorAction SilentlyContinue

# npm's shims call node from PATH, which fails with a private runtime. Replace
# them with a launcher that names the Node we resolved.
$binDir = Join-Path $HermitHome 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
foreach ($shim in @('hermit', 'hermit.cmd', 'hermit.ps1')) {
  $p = Join-Path $binDir $shim
  if (Test-Path $p) { Remove-Item -Force $p }
}
$launcher = @(
  '@echo off',
  ('"' + $nodeExe + '" "' + $HermitHome + '/lib/node_modules/hermit-console/bin/hermit.mjs" %*')
)
Set-Content -Path (Join-Path $binDir 'hermit.cmd') -Value $launcher -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = @($userPath -split ';' | Where-Object { $_ })
if ($parts -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
  Say ''
  Say ('Hermit installed. Added ' + $binDir + ' to your user PATH.')
  Say 'Open a new terminal, then run: hermit'
} else {
  Say ''
  Say 'Hermit installed.'
  Say 'Run: hermit'
}
