param([string]$Action = "fix-api-root")

$cfg = Get-Content "$env:USERPROFILE\.railway\config.json" | ConvertFrom-Json
$TOKEN = $cfg.user.token
$headers = @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" }

function gql($query) {
    $body = @{ query = $query } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Uri "https://backboard.railway.com/graphql/v2" -Method POST -Body $body -Headers $headers
    return $r
}

if ($Action -eq "fix-api-root") {
    $q = 'mutation { serviceInstanceUpdate(serviceId: "c9ae982d-8f40-4d03-9c36-53b56144174f", environmentId: "45df8644-a2c2-431b-87c8-2d6bc228ec76", input: { rootDirectory: "server", buildCommand: "npm install && npm run build", startCommand: "node dist/index.js" }) }'
    $r = gql $q
    if ($r.errors) { Write-Host "ERROR: $($r.errors[0].message)" } else { Write-Host "OK: API service root set to 'server'" }
}

if ($Action -eq "fix-frontend-root") {
    $q = 'mutation { serviceInstanceUpdate(serviceId: "816d1dbb-ac7d-4470-8fe9-f7c810985ee2", environmentId: "45df8644-a2c2-431b-87c8-2d6bc228ec76", input: { rootDirectory: "", buildCommand: "npm run build", startCommand: "npx serve dist -l $PORT" }) }'
    $r = gql $q
    if ($r.errors) { Write-Host "ERROR: $($r.errors[0].message)" } else { Write-Host "OK: Frontend service root cleared" }
}

if ($Action -eq "set-access-code") {
    param([string]$Code)
    $q = "mutation { variableUpsert(input: { serviceId: `"c9ae982d-8f40-4d03-9c36-53b56144174f`", environmentId: `"45df8644-a2c2-431b-87c8-2d6bc228ec76`", name: `"ACCESS_CODE`", value: `"$Code`" }) }"
    $r = gql $q
    if ($r.errors) { Write-Host "ERROR: $($r.errors[0].message)" } else { Write-Host "OK: ACCESS_CODE set" }
}
