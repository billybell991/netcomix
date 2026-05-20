$cfg = Get-Content "$env:USERPROFILE\.railway\config.json" | ConvertFrom-Json
$TOKEN = $cfg.user.token
$headers = @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" }

# Set rootDirectory, buildCommand, startCommand on netcomix-api service
$q = @{
    query = 'mutation($svcId:String!, $envId:String!, $input:ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId:$svcId, environmentId:$envId, input:$input) }'
    variables = @{
        svcId = "c9ae982d-8f40-4d03-9c36-53b56144174f"
        envId = "45df8644-a2c2-431b-87c8-2d6bc228ec76"
        input = @{
            buildCommand = "npm install && npm run build"
            startCommand = "npm start"
            rootDirectory = "server"
        }
    }
} | ConvertTo-Json -Depth 5

$r = Invoke-RestMethod -Uri "https://backboard.railway.com/graphql/v2" -Method POST -Body $q -Headers $headers
if ($r.errors) {
    Write-Host "ERRORS: $($r.errors | ConvertTo-Json)"
} else {
    Write-Host "Service updated OK"
}
