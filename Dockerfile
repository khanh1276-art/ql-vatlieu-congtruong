FROM node:22-alpine

WORKDIR /app

# Sao chép toàn bộ mã nguồn
COPY . .

# Mở cổng
ENV PORT=3000
EXPOSE 3000

# Khởi chạy máy chủ
CMD ["node", "src/server.js"]
