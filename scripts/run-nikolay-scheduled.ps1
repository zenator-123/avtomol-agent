$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = '--use-system-ca'
$env:GITHUB_TOKEN = & 'C:\Program Files\GitHub CLI\gh.exe' auth token
Set-Location 'C:\Users\dell\Documents\Codex\2026-07-14\new-chat\work\avtomol-agent'
try {
    & node scripts\growth-agent.js
    if ($LASTEXITCODE -ne 0) { throw "НИКОЛАЙ завърши с код $LASTEXITCODE" }
}
finally {
    Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
}
