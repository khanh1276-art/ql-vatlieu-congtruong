#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  CÀI ĐẶT ĐỒNG BỘ ONEDRIVE TỰ ĐỘNG 10H SÁNG TRÊN MÁY CHỦ"
echo "  Tên miền: kho.khanhtran.io.vn"
echo "=========================================================="

# 1. Tự động phát hiện thư mục mã nguồn webapp
APP_DIR=""
for candidate in \
  "/var/www/kho-vatlieu" \
  "/var/www/ql-vatlieu-congtruong" \
  "/var/www/kho.khanhtran.io.vn" \
  "/var/www/html" \
  "$(pwd)" \
  $(find /var/www /home /root -name "server.js" -path "*/src/server.js" 2>/dev/null | head -n 1 | sed 's/\/src\/server.js//'); do
  if [ -n "$candidate" ] && [ -f "$candidate/src/server.js" ]; then
    APP_DIR="$candidate"
    break
  fi
done

if [ -z "$APP_DIR" ]; then
  echo "Lỗi: Không tìm thấy thư mục mã nguồn chứa src/server.js!"
  echo "Vui lòng cd vào thư mục chứa webapp rồi chạy lại lệnh này."
  exit 1
fi

echo ">>> Thư mục phần mềm phát hiện tại: $APP_DIR"

# 2. Cập nhật múi giờ Việt Nam (UTC+7)
echo ">>> [1/5] Cài đặt múi giờ Việt Nam (Asia/Ho_Chi_Minh)..."
timedatectl set-timezone Asia/Ho_Chi_Minh || true
echo "Thời gian hiện tại của máy chủ: $(date)"

# 3. Cài đặt Google Chrome (Headless)
echo ">>> [2/5] Kiểm tra và cài đặt Google Chrome..."
if ! command -v google-chrome &> /dev/null && ! command -v google-chrome-stable &> /dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt update -y
  apt install -y wget curl
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt install -y ./google-chrome-stable_current_amd64.deb || apt --fix-broken install -y
  rm -f google-chrome-stable_current_amd64.deb
fi
echo "Google Chrome đã cài đặt: $(google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null || echo 'OK')"

# 4. Tải hoặc cập nhật file scripts/sync_onedrive_daily.js vào dự án
echo ">>> [3/5] Đảm bảo file sync_onedrive_daily.js có trong thư mục scripts..."
mkdir -p "$APP_DIR/scripts"
mkdir -p "$APP_DIR/data/onedrive_download"
chmod -R 755 "$APP_DIR/data"

curl -sSL https://raw.githubusercontent.com/khanh1276-art/ql-vatlieu-congtruong/main/scripts/sync_onedrive_daily.js -o "$APP_DIR/scripts/sync_onedrive_daily.js"
chmod +x "$APP_DIR/scripts/sync_onedrive_daily.js"

# 5. Cài đặt thư viện Node cần thiết (ws)
echo ">>> [4/5] Cài đặt thư viện ws cho Node.js..."
cd "$APP_DIR"
if [ ! -d "$APP_DIR/node_modules/ws" ]; then
  npm install ws --no-save || true
fi

# 6. Thiết lập Cronjob chạy lúc 10h00 sáng mỗi ngày
echo ">>> [5/5] Thiết lập Crontab chạy tự động lúc 10h00 sáng..."
CRON_CMD="0 10 * * * /usr/bin/node $APP_DIR/scripts/sync_onedrive_daily.js >> /var/log/onedrive_sync.log 2>&1"
(crontab -l 2>/dev/null | grep -v "sync_onedrive_daily.js" ; echo "$CRON_CMD") | crontab -

echo "Lịch Cron hiện tại của máy chủ:"
crontab -l

echo ""
echo "=========================================================="
echo "  🎉 CÀI ĐẶT THÀNH CÔNG!"
echo "  Máy chủ sẽ tự động tải OneDrive vào đúng 10h00 sáng mỗi ngày."
echo "  Đang chạy thử nghiệm đồng bộ ngay bây giờ..."
echo "=========================================================="

/usr/bin/node "$APP_DIR/scripts/sync_onedrive_daily.js"
