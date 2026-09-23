# PHẦN MỀM QUẢN LÝ XUẤT NHẬP KHO VẬT LIỆU XÂY DỰNG CÔNG TRƯỜNG

Phần mềm chuyên dụng cho công trường xây dựng, giúp quản lý chặt chẽ lưu lượng xe vận chuyển vật liệu vào/ra, tự động áp dụng quy chuẩn kích thước thùng xe và định mức khối lượng cố định ($m^3$), đồng thời hỗ trợ nghiệm thu điều chỉnh khi chở vơi/ngọn, trích xuất báo cáo nhật trình hàng ngày và tổng hợp khối lượng lũy kế theo từng Nhà cung cấp.

---

## 🌟 ĐẶC ĐIỂM NỔI BẬT

1. **Zero-Dependency (Không cần cài đặt phức tạp)**:
   - Chạy trực tiếp trên máy tính Windows thông qua file `start.bat`.
   - Cơ sở dữ liệu SQLite cục bộ bền vững (`data/inventory.db`), tự động lưu trữ, không lo mất mạng Internet, dễ sao lưu sang USB hoặc Google Drive.

2. **Quy Chuẩn Xe Cố Định & Nghiệm Thu Linh Hoạt**:
   - Mỗi xe đăng ký sẵn: Biển số xe, Kích thước thùng xe ($Dài \times Rộng \times Cao$), Thể tích hình học và Khối lượng quy chuẩn cố định ($m^3$).
   - Khi xe vào cổng: Gõ hoặc chọn biển số xe $\rightarrow$ Hệ thống tự động điền Nhà cung cấp, loại vật liệu, kích thước và khối lượng chuẩn.
   - **Tùy chọn chở vơi/ngọn**: Cho phép tích chọn để điền thủ công khối lượng nghiệm thu thực nhận kèm lý do (VD: Xe chở vơi trừ $1m^3$, xe chở có ngọn $+1.5m^3$).

3. **Giám Sát Vào / Ra (Check-in / Check-out)**:
   - Check-in: Ghi nhận thời gian xe vào, tự động cấp mã phiếu (`NK-YYYYMMDD-XXXX`).
   - Danh sách xe đang trong công trường: Hiển thị thời gian thực số phút xe đã đỗ trong bãi.
   - Check-out: Bấm nút "XÁC NHẬN RA" $\rightarrow$ tự động chốt thời gian xe ra, hoàn tất lượt giao và cập nhật số liệu.

4. **Báo Cáo Nhật Trình Ngày (Daily Report)**:
   - Bảng tổng hợp theo từng Nhà cung cấp và Loại vật liệu trong ngày.
   - Bảng kê chi tiết từng lượt xe: Giờ vào, Giờ ra, Số hiệu xe, Kích thước thùng, Khối lượng quy chuẩn, Khối lượng nghiệm thu, Ghi chú chở vơi/ngọn.
   - Chức năng **Xuất Excel (.xls)** và **In Báo Cáo A4** trực tiếp.

5. **Báo Cáo Khối Lượng Lũy Kế (Cumulative Report)**:
   - Lọc theo khoảng thời gian tùy chọn (Từ ngày $\rightarrow$ Đến ngày), lọc theo Nhà cung cấp, Loại vật liệu.
   - Bảng tổng hợp lũy kế: Nhà cung cấp nào đã giao bao nhiêu chuyến, tổng khối lượng lũy kế bao nhiêu $m^3$, tỷ lệ % đóng góp.
   - Bảng theo dõi năng suất từng xe và diễn biến dồn tích theo ngày.
   - Chức năng **Xuất Excel Báo Cáo Lũy Kế**.

---

## 🚀 HƯỚNG DẪN KHỞI CHẠY

### Cách 1: Click đúp chuột vào file `start.bat`
- Mở thư mục `C:\Users\Khanh\.gemini\antigravity\scratch\ql-vatlieu-congtruong`
- Click đúp vào file `start.bat`
- Trình duyệt web sẽ tự động mở trang ứng dụng tại địa chỉ: `http://localhost:3000`

### Cách 2: Chạy qua dòng lệnh (Command Line / PowerShell)
```powershell
& "C:\Users\Khanh\AppData\Roaming\Antigravity\bin\agy-node.cmd" "C:\Users\Khanh\.gemini\antigravity\scratch\ql-vatlieu-congtruong\src\server.js"
```

---

## 📂 CẤU TRÚC THƯ MỤC DỰ ÁN

```
ql-vatlieu-congtruong/
├── data/
│   └── inventory.db        # Cơ sở dữ liệu SQLite lưu toàn bộ dữ liệu
├── public/
│   ├── index.html          # Giao diện người dùng
│   ├── app.js              # Xử lý logic và API client
│   └── style.css           # Định dạng giao diện & in ấn
├── src/
│   ├── db.js               # Khởi tạo bảng biểu và dữ liệu mẫu
│   └── server.js           # Máy chủ REST API và xuất file Excel
├── start.bat               # File click khởi chạy nhanh
└── README.md
```

---

## 💾 SAO LƯU & DỰ PHÒNG DỮ LIỆU

- Toàn bộ dữ liệu của công trường nằm trong file:
  `C:\Users\Khanh\.gemini\antigravity\scratch\ql-vatlieu-congtruong\data\inventory.db`
- Cuối ngày hoặc cuối tuần, bạn chỉ cần copy file `inventory.db` lưu vào USB hoặc đám mây để dự phòng an toàn tuyệt đối.
