# 관리자 페이지(/admin/) 비밀번호 설정.
# 비밀번호는 이 PC에서만 입력받고, 서버에는 {SSHA} 해시만 보낸다 (nginx auth_basic 형식).
$ErrorActionPreference = 'Stop'
$aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$instance = 'i-0af56579a4627975b'

function Read-Plain($prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$p1 = Read-Plain '관리자 비밀번호 (영문 입력 상태로)'
$p2 = Read-Plain '한 번 더 입력'
if ($p1 -ne $p2) { Write-Host '두 비밀번호가 달라요. 다시 실행해 주세요.' -ForegroundColor Red; exit 1 }
if ($p1.Length -lt 6) { Write-Host '6자 이상으로 해 주세요.' -ForegroundColor Red; exit 1 }

# {SSHA} = base64(SHA1(비밀번호 + salt) + salt)
$salt = New-Object byte[] 8
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
$pw = [Text.Encoding]::UTF8.GetBytes($p1)
$sha = [Security.Cryptography.SHA1]::Create().ComputeHash([byte[]]($pw + $salt))
$line = 'admin:{SSHA}' + [Convert]::ToBase64String([byte[]]($sha + $salt))
$p1 = $null; $p2 = $null

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line + "`n"))
$params = @{ commands = @(
  "echo $b64 | base64 -d > /etc/nginx/temi-admin.htpasswd",
  'chown root:www-data /etc/nginx/temi-admin.htpasswd',
  'chmod 640 /etc/nginx/temi-admin.htpasswd',
  'nginx -t && systemctl reload nginx'
) } | ConvertTo-Json -Depth 3
$file = Join-Path $env:TEMP 'temi-admin-pw.json'
[IO.File]::WriteAllText($file, $params)
try {
  $cmd = & $aws ssm send-command --instance-ids $instance --document-name AWS-RunShellScript --comment 'temi admin password' --parameters "file://$file" --query Command.CommandId --output text
} finally { Remove-Item $file -ErrorAction SilentlyContinue }

Write-Host '서버에 저장하는 중...'
do { Start-Sleep -Seconds 3; $st = & $aws ssm get-command-invocation --command-id $cmd --instance-id $instance --query Status --output text 2>$null } while ($st -in @('Pending', 'InProgress', 'Delayed', ''))
if ($st -eq 'Success') { Write-Host '완료! 아이디 admin 과 방금 비밀번호로 http://54.117.20.190/admin/ 에 로그인하세요.' -ForegroundColor Green }
else { Write-Host "실패했어요 (상태: $st)" -ForegroundColor Red }
