# AWS 배포 (EC2 서울, 무료 플랜)

서버 한 대에 nginx(80번) → Node 서버(3000번, systemd `temi-rental`)로 올린다. 주소와 사용법은 루트 `README.md`의 "AWS 서버" 항목.

| 파일 | 하는 일 |
|---|---|
| `setup.sh` | 서버 안에서 한 번 실행. 스왑 1GB, Node.js 22, nginx(WebSocket·SSE 프록시, 관리자 기본 인증), systemd 서비스, `deploy.sh` 생성. 여러 번 실행해도 안전하다 |
| `set-admin-password.ps1` | 관리자 페이지 비밀번호 설정. 비밀번호는 PC에서만 입력받고 서버에는 해시만 보낸다 |
| `cleanup.ps1` | 만든 AWS 리소스를 모두 지운다 (학기 끝나면). 되돌릴 수 없다 |

## 만든 리소스 (계정 924535763341, ap-northeast-2)

| 리소스 | ID | 비고 |
|---|---|---|
| EC2 | `i-0af56579a4627975b` | t3.micro, Ubuntu 24.04, gp3 20GB, CPU 크레딧 standard (추가 요금 없음) |
| 탄력적 IP | `54.117.20.190` (`eipalloc-0eac6da264f9d6121`) | 시간당 $0.005 → 무료 플랜 크레딧에서 차감 |
| 보안 그룹 | `sg-0242f3a3f53f0f2d7` | 80번 전체, 22번은 처음 설정한 PC IP만 (SSH는 안 쓴다) |
| IAM 역할 | `temi-rental-ssm-role` | SSM으로 서버 관리 (SSH 대신) |
| 예산 알림 | `temi-zero-spend` ($0.01), `temi-1usd` ($1) | 초과하면 메일 |

## 서버 관리 (SSH 대신 SSM)

핫스팟·학교 Wi-Fi에서는 SSH가 막혀서 AWS Systems Manager로 관리한다. AWS CLI 로그인과 Session Manager 플러그인이 필요하다.

```bash
# main 최신 코드로 다시 배포
aws ssm send-command --instance-ids i-0af56579a4627975b --document-name AWS-RunShellScript --parameters commands="/opt/temi-library-rental/deploy.sh"

# 서버 셸 접속 (로그: journalctl -u temi-rental -f)
aws ssm start-session --target i-0af56579a4627975b
```

## 무료로 계속 쓰려면

- 무료 플랜은 2027-05-04에 끝난다. 그 전에 크레딧($100)이 다 떨어져도 끝난다. 유료로 업그레이드하지 않으면 청구되지 않는다.
- 인스턴스를 **멈춰 두기만** 하면 탄력적 IP가 노는 상태로 요금이 붙는다. 오래 안 쓸 거면 `cleanup.ps1`로 지운다.
- 인스턴스 타입을 바꾸거나 두 번째 서버·IP·로드 밸런서·NAT Gateway를 만들지 않는다.
