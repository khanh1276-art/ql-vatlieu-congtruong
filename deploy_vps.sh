#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  CÀI ĐẶT TỰ ĐỘNG PHẦN MỀM QUẢN LÝ VẬT LIỆU CÔNG TRƯỜNG"
echo "  Hệ điều hành: Ubuntu Linux"
echo "=========================================================="

# 1. Cập nhật hệ thống & cài các gói cần thiết
echo ">>> [1/6] Đang cập nhật hệ thống Ubuntu..."
export DEBIAN_FRONTEND=noninteractive
apt update -y
apt install -y curl git ufw nginx

# 2. Cài đặt Node.js 22 (bắt buộc >= 22.5.0 cho node:sqlite)
echo ">>> [2/6] Đang kiểm tra và cài đặt Node.js v22..."
NEED_NODE=0
if ! command -v node &> /dev/null; then
  NEED_NODE=1
else
  NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
  if [ "$NODE_MAJOR" -lt 22 ]; then
    NEED_NODE=1
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

echo "Node.js version: $(node -v)"
echo "NPM version: $(npm -v)"

# 3. Cài đặt PM2
echo ">>> [3/6] Đang cài đặt PM2..."
npm install -g pm2

# 4. Tải mã nguồn dự án
echo ">>> [4/6] Đang tải mã nguồn dự án..."
APP_DIR="/var/www/ql-vatlieu-congtruong"
if [ -d "$APP_DIR/.git" ]; then
  echo "Thư mục $APP_DIR đã tồn tại, đang pull cập nhật mới nhất..."
  cd "$APP_DIR"
  git pull origin main
else
  mkdir -p /var/www
  cd /var/www
  git clone https://github.com/khanh1276-art/ql-vatlieu-congtruong.git
  cd "$APP_DIR"
fi

# 5. Khởi chạy ứng dụng với PM2
echo ">>> [5/6] Khởi chạy ứng dụng với PM2..."
pm2 delete ql-vatlieu 2>/dev/null || true
pm2 start src/server.js --name "ql-vatlieu"
pm2 save
pm2 startup systemd -u root --hp /root || true

# 6. Cấu hình Nginx Reverse Proxy
echo ">>> [6/6] Cấu hình Nginx Reverse Proxy..."
cat << 'EOF' > /etc/nginx/sites-available/ql-vatlieu
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

ln -sf /etc/nginx/sites-available/ql-vatlieu /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

# 7. Mở Firewall
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
echo "y" | ufw enable || true

SERVER_IP=$(curl -s https://ifconfig.me || hostname -I | awk '{print $1}')

echo ""
echo "=========================================================="
echo "  🎉 CÀI ĐẶT HOÀN TẤT THÀNH CÔNG!"
echo "  Phần mềm đang chạy tại:"
echo "  👉 http://$SERVER_IP"
echo "=========================================================="
