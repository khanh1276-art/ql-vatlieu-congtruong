#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  CẬP NHẬT GIAO DIỆN & NÚT BẤM MỚI LÊN KHO.KHANHTRAN.IO.VN"
echo "=========================================================="

APP_DIR=""
for candidate in \
  "/var/www/kho-vatlieu" \
  "/var/www/ql-vatlieu-congtruong" \
  "/var/www/kho.khanhtran.io.vn" \
  "/var/www/html" \
  "$(pwd)" \
  $(find /var/www /home /root -name "index.html" -path "*/public/index.html" 2>/dev/null | head -n 1 | sed 's/\/public\/index.html//'); do
  if [ -n "$candidate" ] && [ -f "$candidate/public/index.html" ]; then
    APP_DIR="$candidate"
    break
  fi
done

if [ -z "$APP_DIR" ]; then
  echo "Lỗi: Không tìm thấy thư mục webapp chứa public/index.html!"
  exit 1
fi

echo ">>> Tìm thấy thư mục webapp tại: $APP_DIR"
echo ">>> Đang tải giao diện index.html và app.js mới nhất..."

curl -sSL "https://raw.githubusercontent.com/khanh1276-art/ql-vatlieu-congtruong/main/public/index.html" -o "$APP_DIR/public/index.html"
curl -sSL "https://raw.githubusercontent.com/khanh1276-art/ql-vatlieu-congtruong/main/public/app.js" -o "$APP_DIR/public/app.js"
curl -sSL "https://raw.githubusercontent.com/khanh1276-art/ql-vatlieu-congtruong/main/src/server.js" -o "$APP_DIR/src/server.js"

if [ -d "$APP_DIR/scripts" ]; then
  curl -sSL "https://raw.githubusercontent.com/khanh1276-art/ql-vatlieu-congtruong/main/scripts/sync_onedrive_daily.js" -o "$APP_DIR/scripts/sync_onedrive_daily.js" || true
fi

if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git pull origin main || true
fi

echo ">>> Khởi động lại dịch vụ Node.js qua PM2 (nếu có)..."
pm2 reload kho-vatlieu 2>/dev/null || pm2 restart all 2>/dev/null || true

echo ""
echo "=========================================================="
echo "  🎉 CẬP NHẬT HOÀN TẤT!"
echo "  Nút 'Đồng Bộ Dữ Liệu Ngay' đã có mặt trên https://kho.khanhtran.io.vn"
echo "  Anh chỉ cần bấm Ctrl + F5 trên trình duyệt là sẽ thấy ngay!"
echo "=========================================================="
