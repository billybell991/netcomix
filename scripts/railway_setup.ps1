param(
    [string]$Step = "status"
)

$cfg = Get-Content "$env:USERPROFILE\.railway\config.json" | ConvertFrom-Json
$TOKEN = $cfg.user.token
$PROJECT_ID = "3e2b82d7-6d6d-4fa3-9674-0b9310bc5924"
$ENV_ID = "45df8644-a2c2-431b-87c8-2d6bc228ec76"
$API_SERVICE_ID = "c55a77d5-e19e-43ea-8669-edd295a31339"

$headers = @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" }

function Invoke-RailwayGQL($query, $variables = @{}) {
    $body = @{ query = $query; variables = $variables } | ConvertTo-Json -Depth 10
    $r = Invoke-RestMethod -Uri "https://backboard.railway.com/graphql/v2" -Method POST -Body $body -Headers $headers
    if ($r.errors) { Write-Error ($r.errors | ConvertTo-Json); exit 1 }
    return $r.data
}

if ($Step -eq "status") {
    $q = 'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }'
    $d = Invoke-RailwayGQL $q @{ id = $PROJECT_ID }
    Write-Host "Services in project:"
    $d.project.services.edges | ForEach-Object { Write-Host "  $($_.node.id)  $($_.node.name)" }
}

if ($Step -eq "get-pg-url") {
    # Get the Postgres service and its DATABASE_URL variable
    $q = 'query($id:String!,$envId:String!){ project(id:$id){ services{ edges{ node{ id name variables(environmentId:$envId){ edges{ node{ name value } } } } } } } }'
    $d = Invoke-RailwayGQL $q @{ id = $PROJECT_ID; envId = $ENV_ID }
    $d.project.services.edges | ForEach-Object {
        $svc = $_.node
        Write-Host "Service: $($svc.name) ($($svc.id))"
        $svc.variables.edges | ForEach-Object {
            if ($_.node.name -like "*DATABASE*" -or $_.node.name -like "*POSTGRES*" -or $_.node.name -like "*PG*") {
                Write-Host "  $($_.node.name) = $($_.node.value)"
            }
        }
    }
}

if ($Step -eq "set-vars") {
    # Set variables on the API service
    # The DATABASE_URL will use a Railway reference variable pointing to the Postgres service
    $pgServiceQuery = 'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }'
    $d = Invoke-RailwayGQL $pgServiceQuery @{ id = $PROJECT_ID }
    $pgService = $d.project.services.edges | Where-Object { $_.node.name -eq "Postgres" } | Select-Object -First 1
    $pgServiceId = $pgService.node.id
    Write-Host "Postgres service ID: $pgServiceId"

    # Vars to set — R2/ACCESS_CODE values will be filled from environment
    $vars = @{
        DATABASE_URL     = "`${{Postgres.DATABASE_URL}}"
        ACCESS_CODE      = $env:ACCESS_CODE
        R2_BUCKET        = $env:R2_BUCKET
        R2_ENDPOINT_URL  = $env:R2_ENDPOINT_URL
        R2_ACCESS_KEY_ID = $env:R2_ACCESS_KEY_ID
        R2_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY
        R2_PUBLIC_URL    = $env:R2_PUBLIC_URL
    }

    foreach ($kv in $vars.GetEnumerator()) {
        if ([string]::IsNullOrEmpty($kv.Value)) {
            Write-Host "SKIP (empty): $($kv.Key)"
            continue
        }
        $mutation = 'mutation($svcId:String!,$envId:String!,$name:String!,$value:String!){ variableUpsert(input:{ serviceId:$svcId, environmentId:$envId, name:$name, value:$value }) }'
        Invoke-RailwayGQL $mutation @{ svcId = $API_SERVICE_ID; envId = $ENV_ID; name = $kv.Key; value = $kv.Value } | Out-Null
        Write-Host "SET: $($kv.Key)"
    }
}

if ($Step -eq "set-single") {
    param([string]$Name, [string]$Value)
    $mutation = 'mutation($svcId:String!,$envId:String!,$name:String!,$value:String!){ variableUpsert(input:{ serviceId:$svcId, environmentId:$envId, name:$name, value:$value }) }'
    Invoke-RailwayGQL $mutation @{ svcId = $API_SERVICE_ID; envId = $ENV_ID; name = $Name; value = $Value } | Out-Null
    Write-Host "SET: $Name"
}

if ($Step -eq "get-domain") {
    $q = 'query($svcId:String!,$envId:String!){ domains(serviceId:$svcId, environmentId:$envId){ serviceDomains{ domain } } }'
    $d = Invoke-RailwayGQL $q @{ svcId = $API_SERVICE_ID; envId = $ENV_ID }
    $d.domains.serviceDomains | ForEach-Object { Write-Host $_.domain }
}

if ($Step -eq "gen-domain") {
    $mutation = 'mutation($svcId:String!,$envId:String!){ serviceDomainCreate(input:{ serviceId:$svcId, environmentId:$envId }){ domain } }'
    $d = Invoke-RailwayGQL $mutation @{ svcId = $API_SERVICE_ID; envId = $ENV_ID }
    Write-Host "API domain: $($d.serviceDomainCreate.domain)"
}
