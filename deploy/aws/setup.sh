#!/usr/bin/env bash
# temi-library-rental 서버 설정 (Ubuntu 24.04, t3.micro). 여러 번 실행해도 안전하다.
set -euo pipefail

APP_DIR=/opt/temi-library-rental
REPO=https://github.com/hhjae1/temi-library-rental.git

echo "== 1GB 스왑 (메모리 1GB라 npm ci 중 멈추지 않게)"
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 패키지"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git nginx apache2-utils ca-certificates curl

echo "== Node.js 22"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 앱 사용자·코드"
id temi >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin temi
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
chown -R temi:temi "$APP_DIR"
sudo -u temi bash -c "cd $APP_DIR/server && npm ci --omit=dev --no-audit --no-fund"

echo "== systemd 서비스"
cat > /etc/systemd/system/temi-rental.service <<'UNIT'
[Unit]
Description=TEMI library rental server
After=network-online.target
Wants=network-online.target

[Service]
User=temi
WorkingDirectory=/opt/temi-library-rental/server
Environment=PORT=3000
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/main.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now temi-rental
systemctl restart temi-rental

echo "== nginx"
cat > /etc/nginx/sites-available/temi-rental <<'NGINX'
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  # TEMI 로봇 WebSocket
  location /ws/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  # 앱·관리자 실시간 갱신 (SSE)
  location /api/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
  }

  # 관리자 화면·관리자 API는 기본 인증
  location /admin/ {
    auth_basic "TEMI admin";
    auth_basic_user_file /etc/nginx/temi-admin.htpasswd;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
  }
  location /api/admin/ {
    auth_basic "TEMI admin";
    auth_basic_user_file /etc/nginx/temi-admin.htpasswd;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/temi-rental /etc/nginx/sites-enabled/temi-rental
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

echo "== 업데이트 스크립트"
cat > "$APP_DIR/deploy.sh" <<'DEPLOY'
#!/usr/bin/env bash
# 사용법: sudo /opt/temi-library-rental/deploy.sh   (GitHub main의 최신 코드로 다시 배포)
set -euo pipefail
cd /opt/temi-library-rental
sudo -u temi git pull --ff-only
cd server
sudo -u temi npm ci --omit=dev --no-audit --no-fund
systemctl restart temi-rental
sleep 2
curl -fsS http://127.0.0.1:3000/api/info && echo
DEPLOY
chmod +x "$APP_DIR/deploy.sh"

echo "== 자동 배포: 2분마다 GitHub main을 확인해서 새 커밋이 있으면 deploy.sh"
cat > "$APP_DIR/autodeploy.sh" <<'AUTO'
#!/usr/bin/env bash
# temi-autodeploy.timer가 2분마다 실행한다. 새 커밋이 없으면 아무것도 하지 않는다.
set -euo pipefail
cd /opt/temi-library-rental
sudo -u temi git fetch -q origin main
local_rev=$(sudo -u temi git rev-parse HEAD)
remote_rev=$(sudo -u temi git rev-parse origin/main)
[ "$local_rev" = "$remote_rev" ] && exit 0
echo "새 커밋 ${remote_rev:0:7} 배포 (이전 ${local_rev:0:7})"
exec /opt/temi-library-rental/deploy.sh
AUTO
chmod +x "$APP_DIR/autodeploy.sh"

cat > /etc/systemd/system/temi-autodeploy.service <<'UNIT'
[Unit]
Description=Deploy temi-library-rental when GitHub main changes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# 이전 배포가 아직 돌고 있으면 건너뛴다
ExecStart=/usr/bin/flock -n /run/temi-autodeploy.lock /opt/temi-library-rental/autodeploy.sh
UNIT

cat > /etc/systemd/system/temi-autodeploy.timer <<'UNIT'
[Unit]
Description=Check GitHub main every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now temi-autodeploy.timer

echo "== 확인"
sleep 2
systemctl is-active temi-rental
systemctl is-active temi-autodeploy.timer
curl -fsS http://127.0.0.1:3000/api/info && echo
