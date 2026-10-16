#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  CÀI ĐẶT ĐỒNG BỘ ONEDRIVE TỰ ĐỘNG 10H SÁNG TRÊN VPS"
echo "  Tên miền: kho.khanhtran.io.vn"
echo "=========================================================="

APP_DIR="/var/www/ql-vatlieu-congtruong"

if [ ! -d "$APP_DIR" ]; then
  echo "Lỗi: Không tìm thấy thư mục $APP_DIR. Vui lòng chạy deploy_vps.sh trước!"
  exit 1
fi

# 1. Cập nhật múi giờ Việt Nam (UTC+7)
echo ">>> [1/4] Cài đặt múi giờ Việt Nam (Asia/Ho_Chi_Minh)..."
timedatectl set-timezone Asia/Ho_Chi_Minh
echo "Thời gian hiện tại của máy chủ: $(date)"

# 2. Cài đặt Google Chrome (Headless)
echo ">>> [2/4] Kiểm tra và cài đặt Google Chrome..."
if ! command -v google-chrome &> /dev/null && ! command -v google-chrome-stable &> /dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt update -y
  apt install -y wget
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt install -y ./google-chrome-stable_current_amd64.deb
  rm -f google-chrome-stable_current_amd64.deb
fi
echo "Google Chrome: $(google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null || echo 'OK')"

# 3. Đảm bảo npm dependencies đã cài đặt
echo ">>> [3/4] Cài đặt thư viện phụ thuộc..."
cd "$APP_DIR"
git pull origin main || true
npm install --omit=dev

# 4. Thiết lập Cronjob 10h sáng hàng ngày
echo ">>> [4/4] Thiết lập lịch tự động 10h00 sáng hàng ngày (Crontab)..."
CRON_JOB="0 10 * * * /usr/bin/node $APP_DIR/scripts/sync_onedrive_daily.js >> /var/log/onedrive_sync.log 2>&1"
(crontab -l 2>/dev/null | grep -v "sync_onedrive_daily.js" ; echo "$CRON_JOB") | crontab -

echo "Lịch Cron hiện tại:"
crontab -l

echo ""
echo "=========================================================="
echo "  🎉 CÀI ĐẶT THÀNH CÔNG!"
echo "  Tác vụ tự động tải OneDrive vào 10h00 sáng đã được kích hoạt."
echo "  Đang chạy thử nghiệm đồng bộ ngay bây giờ..."
echo "=========================================================="

node "$APP_DIR/scripts/sync_onedrive_daily.js"
