$ErrorActionPreference = 'Stop'
$d = Split-Path -Parent $PSScriptRoot   # design-v2
$b = $PSScriptRoot

$tpl = @{
  sidebar = Get-Content "$b\tpl-sidebar.html" -Raw -Encoding UTF8
  view    = Get-Content "$b\tpl-view.html" -Raw -Encoding UTF8
}

$screens = @(
  @{ n = 'draft';        t = '计划裁决 · myteam';          f = 'sidebar'; on = 'TASKS' },
  @{ n = 'empty';        t = '空团队 · myteam';            f = 'sidebar'; on = 'TASKS' },
  @{ n = 'member-menu';  t = '成员管理 · myteam';          f = 'sidebar'; on = 'ROLES' },
  @{ n = 'archive';      t = '归档回放 · myteam';          f = 'sidebar'; on = 'AUDIT' },
  @{ n = 'presets';      t = '预设库 · myteam';            f = 'sidebar'; on = 'ROLES' },
  @{ n = 'skills';       t = '技能与 MCP · myteam';        f = 'sidebar'; on = 'ROLES' },
  @{ n = 'unavailable';  t = '会话标签页 · 未启用 · myteam'; f = 'view';    on = '' },
  @{ n = 'guest';        t = '会话标签页 · 单角色 · myteam'; f = 'view';    on = '' }
)

foreach ($s in $screens) {
  $page = Get-Content "$b\body\$($s.n).html" -Raw -Encoding UTF8
  $out = $tpl[$s.f].Replace('{{TITLE}}', $s.t).Replace('{{PAGE}}', $page.TrimEnd())
  foreach ($k in 'TASKS', 'ROLES', 'KNOW', 'AUDIT', 'SET') {
    $val = if ($s.on -eq $k) { 'on' } else { '' }
    $out = $out.Replace('{{ON_' + $k + '}}', $val)
  }
  if ($out -match '\{\{') { throw "未替换的占位符：$($s.n)" }
  Set-Content -Path "$d\$($s.n).html" -Value $out -Encoding UTF8 -NoNewline
  Write-Output "built $($s.n).html"
}
