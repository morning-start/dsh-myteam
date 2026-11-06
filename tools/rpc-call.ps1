param(
  [Parameter(Mandatory=$true)][string]$Endpoint,
  [Parameter(Mandatory=$true)][string]$ArgsJson,
  [string]$Base = "http://127.0.0.1:3080",
  [string]$Token = "rBG9yKIRtaSRA7ldIKffKQYiVgBWoyszfzX91hnVNmU"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$cookieFile = "E:\Workplace\extension\dsh-myteam\tmp\.rpc-cookie"

# 取 cookie：缓存优先；否则 GET /connect?token=<launchToken> 铸 API operator cookie
if (Test-Path $cookieFile) {
  $cookie = (Get-Content $cookieFile -Raw).Trim()
} else {
  $hc = New-Object System.Net.Http.HttpClient
  $hc.DefaultRequestHeaders.TryAddWithoutValidation('Host', '127.0.0.1:3080') | Out-Null
  $task = $hc.GetAsync("$Base/connect?token=$Token")
  $task.Wait()
  $resp0 = $task.Result
  $setCookie = $null
  if ($resp0.Headers.TryGetValues('Set-Cookie', [ref]$setCookie) -and $setCookie.Count -gt 0) {
    $cookie = ($setCookie[0] -split ';')[0]
    Set-Content -Path $cookieFile -Value $cookie -NoNewline
  } else {
    throw "no set-cookie from /connect: HTTP $([int]$resp0.StatusCode)"
  }
}

$rpcId = [guid]::NewGuid().ToString('N')
$body = @{
  type = 'client-request'
  rpcId = $rpcId
  method = $Endpoint
  payload = @{ args = ($ArgsJson | ConvertFrom-Json) }
} | ConvertTo-Json -Depth 12 -Compress

function Invoke-RpcOnce($cookieVal) {
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(65)
  $client.DefaultRequestHeaders.TryAddWithoutValidation('Cookie', $cookieVal) | Out-Null
  $content = New-Object System.Net.Http.ByteArrayContent(,[System.Text.Encoding]::UTF8.GetBytes($body))
  $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
  $t = $client.PostAsync("$Base/api/$Endpoint", $content)
  $t.Wait()
  $resp = $t.Result
  $rt = $resp.Content.ReadAsStringAsync()
  $rt.Wait()
  return @{ status = [int]$resp.StatusCode; body = $rt.Result }
}

$r = Invoke-RpcOnce $cookie
if ($r.status -eq 401) {
  Remove-Item $cookieFile -ErrorAction SilentlyContinue
  throw "401 after cookie refresh attempt"
}
"HTTP $($r.status)"
$r.body
