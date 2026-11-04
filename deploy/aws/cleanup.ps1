# AWS에 만든 temi-library-rental 리소스를 모두 지운다. 학기가 끝나면 한 번 실행한다.
# 지운 것은 되돌릴 수 없다 (서버의 대여 기록 DB도 함께 사라진다).
#
# 실행: powershell -ExecutionPolicy Bypass -File deploy\aws\cleanup.ps1
$ErrorActionPreference = 'Continue'
$aws = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$region = 'ap-northeast-2'

$instance = 'i-0af56579a4627975b'
$allocation = 'eipalloc-0eac6da264f9d6121' # 54.117.20.190
$securityGroup = 'sg-0242f3a3f53f0f2d7'
$keyPair = 'temi-rental-key'
$role = 'temi-rental-ssm-role'
$profile = 'temi-rental-ssm-profile'
$budgets = @('temi-zero-spend', 'temi-1usd')

Write-Host '다음 AWS 리소스를 모두 지웁니다:' -ForegroundColor Yellow
Write-Host "  EC2 인스턴스 $instance (디스크·DB 포함)"
Write-Host "  탄력적 IP $allocation (54.117.20.190)"
Write-Host "  보안 그룹 $securityGroup, 키 페어 $keyPair"
Write-Host "  IAM 역할 $role, 인스턴스 프로필 $profile"
Write-Host "  예산 알림 $($budgets -join ', ')"
if ((Read-Host "정말 지우려면 '삭제'라고 입력하세요") -ne '삭제') { Write-Host '취소했어요.'; exit 0 }

Write-Host '1/6 인스턴스 종료 (몇 분 걸려요)'
& $aws ec2 terminate-instances --region $region --instance-ids $instance --query 'TerminatingInstances[0].CurrentState.Name' --output text
& $aws ec2 wait instance-terminated --region $region --instance-ids $instance

Write-Host '2/6 탄력적 IP 반납 (안 지우면 시간당 요금이 나와요)'
& $aws ec2 release-address --region $region --allocation-id $allocation

Write-Host '3/6 보안 그룹 삭제'
& $aws ec2 delete-security-group --region $region --group-id $securityGroup

Write-Host '4/6 키 페어 삭제'
& $aws ec2 delete-key-pair --region $region --key-name $keyPair
$keyFile = Join-Path $env:USERPROFILE ".ssh\$keyPair.pem"
if (Test-Path $keyFile) { Remove-Item $keyFile -Force; Write-Host "  내 PC의 키 파일도 지웠어요: $keyFile" }

Write-Host '5/6 IAM 역할 삭제'
& $aws iam remove-role-from-instance-profile --instance-profile-name $profile --role-name $role
& $aws iam delete-instance-profile --instance-profile-name $profile
& $aws iam detach-role-policy --role-name $role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
& $aws iam delete-role --role-name $role

Write-Host '6/6 예산 알림 삭제'
$account = & $aws sts get-caller-identity --query Account --output text
foreach ($b in $budgets) { & $aws budgets delete-budget --account-id $account --budget-name $b }

Write-Host '--- 남은 리소스 확인 (아무것도 안 나오면 정리 완료)' -ForegroundColor Green
& $aws ec2 describe-instances --region $region --filters 'Name=instance-state-name,Values=pending,running,stopping,stopped' --query 'Reservations[].Instances[].InstanceId' --output text
& $aws ec2 describe-addresses --region $region --query 'Addresses[].PublicIp' --output text
