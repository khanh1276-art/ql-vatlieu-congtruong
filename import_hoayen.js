const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const { db } = require('./src/db.js');

const filePath = 'D:\\Antigravity\\XUAT NHAP KHO\\DATA\\Hoa Yen\\VT Hòa Yên báo cáo 24.09.2026.xlsx';
console.log('--- BẮT ĐẦU NẠP DỮ LIỆU DỰ ÁN HÒA YÊN VÀO CƠ SỞ DỮ LIỆU ---');

// 1. Sao lưu database trước khi nạp
const dbPath = path.join(__dirname, 'data', 'inventory.db');
const backupPath = path.join(__dirname, 'data', `inventory_backup_before_hoayen_${Date.now()}.db`);
if (fs.existsSync(dbPath)) {
  fs.copyFileSync(dbPath, backupPath);
  console.log(`[Backup] Đã tạo bản sao lưu an toàn tại: ${backupPath}`);
}

const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });

function parseDateStr(w, v) {
  if (w && typeof w === 'string' && w.includes('/')) {
    const parts = w.trim().split('/');
    if (parts.length === 3) {
      let [m, d, y] = parts;
      if (y.length === 2) y = '20' + y;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  if (v instanceof Date) {
    const localD = new Date(v.getTime() + 7 * 3600 * 1000 + 30000);
    const y = localD.getUTCFullYear();
    const m = String(localD.getUTCMonth() + 1).padStart(2, '0');
    const d = String(localD.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

// 2. Thu thập định mức thể tích xe từ các dòng có sẵn
const vehicleVolumeMap = {};
wb.SheetNames.forEach(s => {
  const ws = wb.Sheets[s];
  if (!ws) return;
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  for (let r = 44; r <= range.e.r; r++) {
    const plate = (ws[XLSX.utils.encode_cell({r, c: 7})]?.w || ws[XLSX.utils.encode_cell({r, c: 7})]?.v || '').toString().trim();
    const vol = parseFloat(ws[XLSX.utils.encode_cell({r, c: 9})]?.v || ws[XLSX.utils.encode_cell({r, c: 9})]?.w);
    if (plate && !isNaN(vol) && vol > 0) {
      if (!vehicleVolumeMap[plate]) vehicleVolumeMap[plate] = vol;
    }
  }
});

// 3. Khởi tạo / Lấy Dự Án Hòa Yên
let hoayenProject = db.prepare("SELECT * FROM projects WHERE code = 'DA-HOAYEN'").get();
if (!hoayenProject) {
  const info = db.prepare(`
    INSERT INTO projects (code, name, location, status, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'DA-HOAYEN',
    'Dự án Hòa Yên',
    'Hòa Yên',
    'ACTIVE',
    'Dự án nhập từ file Excel VT Hòa Yên báo cáo 24.09.2026.xlsx'
  );
  hoayenProject = db.prepare("SELECT * FROM projects WHERE id = ?").get(info.lastInsertRowid);
  console.log(`[Dự án] Đã tạo mới dự án: "${hoayenProject.name}" (ID: ${hoayenProject.id})`);
} else {
  console.log(`[Dự án] Đã tìm thấy dự án: "${hoayenProject.name}" (ID: ${hoayenProject.id})`);
}

// Xóa các vé cũ của dự án Hòa Yên nếu trước đó đã từng nạp để tránh trùng lặp
const deletedTickets = db.prepare("DELETE FROM tickets WHERE project_id = ?").run(hoayenProject.id);
if (deletedTickets.changes > 0) {
  console.log(`[Dọn dẹp] Đã xóa ${deletedTickets.changes} phiếu cũ của dự án Hòa Yên để nạp lại mới nhất`);
}

// 4. Khởi tạo Danh mục Nhà Cung Cấp
const supplierConfigs = [
  { code: 'NCC-TRITHANH', name: 'Công ty TNHH Trí Thành', notes: 'Cung cấp Đất - Mỏ Trại Cau' },
  { code: 'NCC-KHANGMINH', name: 'Công ty Khang Minh', notes: 'Cung cấp Đất san lấp' },
  { code: 'NCC-TRITHANH-BKC', name: 'Công ty TNHH Trí Thành (Bãi Khởi Công)', notes: 'Cung cấp Đất - Bãi khởi công' },
  { code: 'NCC-PHATDAT-PL01', name: 'Công ty TNHH Phát Đạt (PL01)', notes: 'Cung cấp Đất - Phụ lục 01' },
  { code: 'NCC-PHATDAT-PL02', name: 'Công ty TNHH Phát Đạt (PL02)', notes: 'Cung cấp Đất - Phụ lục 02' },
  { code: 'NCC-THAOTRANG', name: 'Công ty TNHH Thảo Trang', notes: 'Cung cấp Đá hộc, Cấp phối đá dăm' },
  { code: 'NCC-NINHSON', name: 'Công ty Ninh Sơn', notes: 'Cung cấp CPĐD loại 2' },
  { code: 'NCC-TANTIEN', name: 'Công ty Tân Tiến', notes: 'Cung cấp CPĐD loại 2' }
];

const supplierIdMap = {};
supplierConfigs.forEach(s => {
  let supp = db.prepare("SELECT * FROM suppliers WHERE code = ?").get(s.code);
  if (!supp) {
    const res = db.prepare(`
      INSERT INTO suppliers (code, name, notes) VALUES (?, ?, ?)
    `).run(s.code, s.name, s.notes);
    supp = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(res.lastInsertRowid);
  }
  supplierIdMap[s.name] = supp.id;
  supplierIdMap[s.code] = supp.id;
});

// 5. Khởi tạo Danh mục Vật Liệu
const materialConfigs = [
  { code: 'DAT-SANLAP', name: 'Đất san lấp / Đất đắp', unit: 'm³', desc: 'Đất san lấp nền đường, nền bãi' },
  { code: 'CPDD-LOAI1', name: 'Cấp phối đá dăm loại 1 (Base A)', unit: 'm³', desc: 'CPĐD loại 1 thi công móng đường' },
  { code: 'CPDD-LOAI2', name: 'Cấp phối đá dăm loại 2 (Base B)', unit: 'm³', desc: 'CPĐD loại 2 thi công móng đường' },
  { code: 'DAHOC', name: 'Đá Hộc', unit: 'm³', desc: 'Đá hộc xây kè, móng công trình' },
  { code: 'DADAM', name: 'Đá Dăm', unit: 'm³', desc: 'Đá dăm chèn khe, rải đệm' }
];

const materialIdMap = {};
materialConfigs.forEach(m => {
  let mat = db.prepare("SELECT * FROM materials WHERE code = ?").get(m.code);
  if (!mat) {
    const res = db.prepare(`
      INSERT INTO materials (code, name, unit, description) VALUES (?, ?, ?, ?)
    `).run(m.code, m.name, m.unit, m.desc);
    mat = db.prepare("SELECT * FROM materials WHERE id = ?").get(res.lastInsertRowid);
  }
  materialIdMap[m.name] = mat.id;
  materialIdMap[m.code] = mat.id;
});

// 6. Cấu hình các sheet màu xanh
const greenSheetsConfig = [
  {
    sheetName: 'DAT TRITHANH',
    supplierCode: 'NCC-TRITHANH',
    supplierName: 'Công ty TNHH Trí Thành',
    defaultMaterialCode: 'DAT-SANLAP',
    defaultMaterialName: 'Đất san lấp / Đất đắp',
    defaultUnit: 'm³',
    defaultVolume: 35.0
  },
  {
    sheetName: 'DAT KHANGMINH',
    supplierCode: 'NCC-KHANGMINH',
    supplierName: 'Công ty Khang Minh',
    defaultMaterialCode: 'DAT-SANLAP',
    defaultMaterialName: 'Đất san lấp / Đất đắp',
    defaultUnit: 'm³',
    defaultVolume: 30.0
  },
  {
    sheetName: 'DAT TRITHANH BKC',
    supplierCode: 'NCC-TRITHANH-BKC',
    supplierName: 'Công ty TNHH Trí Thành (Bãi Khởi Công)',
    defaultMaterialCode: 'DAT-SANLAP',
    defaultMaterialName: 'Đất san lấp / Đất đắp',
    defaultUnit: 'm³',
    defaultVolume: 33.0
  },
  {
    sheetName: 'DAT PHATDAT PL01',
    supplierCode: 'NCC-PHATDAT-PL01',
    supplierName: 'Công ty TNHH Phát Đạt (PL01)',
    defaultMaterialCode: 'DAT-SANLAP',
    defaultMaterialName: 'Đất san lấp / Đất đắp',
    defaultUnit: 'm³',
    defaultVolume: 27.0
  },
  {
    sheetName: 'DAT PHATDAT PL02',
    supplierCode: 'NCC-PHATDAT-PL02',
    supplierName: 'Công ty TNHH Phát Đạt (PL02)',
    defaultMaterialCode: 'DAT-SANLAP',
    defaultMaterialName: 'Đất san lấp / Đất đắp',
    defaultUnit: 'm³',
    defaultVolume: 29.0
  },
  {
    sheetName: 'CP LOAI I',
    supplierCode: 'NCC-THAOTRANG',
    supplierName: 'Công ty TNHH Thảo Trang',
    defaultMaterialCode: 'CPDD-LOAI1',
    defaultMaterialName: 'Cấp phối đá dăm loại 1 (Base A)',
    defaultUnit: 'm³',
    defaultVolume: 25.0
  },
  {
    sheetName: 'CP LOAI II',
    supplierCode: 'NCC-THAOTRANG',
    supplierName: 'Công ty TNHH Thảo Trang',
    defaultMaterialCode: 'CPDD-LOAI2',
    defaultMaterialName: 'Cấp phối đá dăm loại 2 (Base B)',
    defaultUnit: 'm³',
    defaultVolume: 25.0
  },
  {
    sheetName: 'DAHOC',
    supplierCode: 'NCC-THAOTRANG',
    supplierName: 'Công ty TNHH Thảo Trang',
    defaultMaterialCode: 'DAHOC',
    defaultMaterialName: 'Đá Hộc',
    defaultUnit: 'm³',
    defaultVolume: 19.5
  }
];

// Chuẩn bị câu lệnh chèn vào database
const insertVehicle = db.prepare(`
  INSERT OR IGNORE INTO vehicles (plate_number, supplier_id, project_id, standard_volume, unit, default_material_id, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertTicket = db.prepare(`
  INSERT INTO tickets (
    ticket_code, project_id, project_name, vehicle_id, plate_number,
    supplier_id, supplier_name, material_id, material_name, unit,
    time_in, time_out, length, width, height, standard_volume, actual_volume,
    is_manual_adjusted, adjustment_reason, status, created_by, notes
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`);

let totalImported = 0;
let totalVolImported = 0;
const dailyTicketSequence = {};

db.exec("BEGIN TRANSACTION;");

try {
  greenSheetsConfig.forEach(cfg => {
    const ws = wb.Sheets[cfg.sheetName];
    if (!ws) return;
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    let sheetTrips = 0;

    for (let r = 44; r <= range.e.r; r++) {
      const cellTripIdx = ws[XLSX.utils.encode_cell({r, c: 1})];
      const cellDate = ws[XLSX.utils.encode_cell({r, c: 2})];
      const cellMat = ws[XLSX.utils.encode_cell({r, c: 3})];
      const cellSource = ws[XLSX.utils.encode_cell({r, c: 4})];
      const cellSupp = ws[XLSX.utils.encode_cell({r, c: 5})];
      const cellPlate = ws[XLSX.utils.encode_cell({r, c: 7})];
      const cellVol = ws[XLSX.utils.encode_cell({r, c: 9})];
      const cellAdjust = ws[XLSX.utils.encode_cell({r, c: 10})];
      const cellAdjustReason = ws[XLSX.utils.encode_cell({r, c: 12})];
      const cellNotes = ws[XLSX.utils.encode_cell({r, c: 13})];

      const dateStr = parseDateStr(cellDate?.w, cellDate?.v);
      if (!dateStr) continue;

      let plate = (cellPlate?.w || cellPlate?.v || '').toString().trim();
      if (!plate) continue;

      let rawVol = parseFloat(cellVol?.v || cellVol?.w);
      let stdVol = rawVol;
      if (isNaN(stdVol) || stdVol <= 0) {
        stdVol = vehicleVolumeMap[plate] || cfg.defaultVolume;
      }

      let adjustNum = parseFloat(cellAdjust?.v || cellAdjust?.w);
      let actualVol = stdVol;
      let isAdjusted = 0;
      let adjustReason = '';

      if (!isNaN(adjustNum) && adjustNum !== 0) {
        isAdjusted = 1;
        actualVol = Math.max(0.1, stdVol + adjustNum);
        adjustReason = `Trừ hao hụt/ngọn: ${adjustNum > 0 ? '+' : ''}${adjustNum} m³`;
      }

      const reasonText = (cellAdjustReason?.w || cellAdjustReason?.v || '').toString().trim();
      if (reasonText && reasonText !== '-') {
        isAdjusted = 1;
        adjustReason = adjustReason ? `${adjustReason} (${reasonText})` : reasonText;
      }

      let suppName = cfg.supplierName;
      let suppCode = cfg.supplierCode;
      const rawSupp = (cellSupp?.w || cellSupp?.v || '').toString().trim();
      if (rawSupp && !rawSupp.includes('*')) {
        if (rawSupp.toLowerCase().includes('ninh sơn')) { suppName = 'Công ty Ninh Sơn'; suppCode = 'NCC-NINHSON'; }
        else if (rawSupp.toLowerCase().includes('tân tiến')) { suppName = 'Công ty Tân Tiến'; suppCode = 'NCC-TANTIEN'; }
        else if (rawSupp.toLowerCase().includes('thảo trang')) { suppName = 'Công ty TNHH Thảo Trang'; suppCode = 'NCC-THAOTRANG'; }
      }
      const suppId = supplierIdMap[suppName] || supplierIdMap[suppCode];

      let matName = cfg.defaultMaterialName;
      let matCode = cfg.defaultMaterialCode;
      const rawMat = (cellMat?.w || cellMat?.v || '').toString().trim();
      if (rawMat && !rawMat.includes('*')) {
        if (rawMat.toLowerCase().includes('đá dăm')) { matName = 'Đá Dăm'; matCode = 'DADAM'; }
        else if (rawMat.toLowerCase().includes('đá hộc')) { matName = 'Đá Hộc'; matCode = 'DAHOC'; }
        else if (rawMat.toLowerCase().includes('loại 2')) { matName = 'Cấp phối đá dăm loại 2 (Base B)'; matCode = 'CPDD-LOAI2'; }
      }
      const matId = materialIdMap[matName] || materialIdMap[matCode];

      const source = (cellSource?.w || cellSource?.v || '').toString().trim();
      const noteText = (cellNotes?.w || cellNotes?.v || '').toString().trim();
      let combinedNotes = [source ? `Nguồn: ${source}` : '', noteText].filter(Boolean).join(' | ');

      // Lưu xe vào bảng vehicles
      insertVehicle.run(
        plate,
        suppId,
        hoayenProject.id,
        parseFloat(stdVol.toFixed(2)),
        cfg.defaultUnit,
        matId,
        `Xe chở cho ${suppName}`
      );

      // Sinh mã phiếu theo ngày: HY-YYYYMMDD-XXXX
      const dateClean = dateStr.replace(/-/g, '');
      dailyTicketSequence[dateClean] = (dailyTicketSequence[dateClean] || 0) + 1;
      const seqStr = String(dailyTicketSequence[dateClean]).padStart(4, '0');
      const ticketCode = `HY-${dateClean}-${seqStr}`;

      // Giả lập thời gian vào ra hợp lý trong ngày (7h đến 18h)
      const hourOffset = 7 + Math.floor((dailyTicketSequence[dateClean] % 10));
      const minuteOffset = (dailyTicketSequence[dateClean] * 7) % 60;
      const timeIn = `${dateStr} ${String(hourOffset).padStart(2, '0')}:${String(minuteOffset).padStart(2, '0')}:00`;
      const timeOut = `${dateStr} ${String(hourOffset).padStart(2, '0')}:${String((minuteOffset + 20) % 60).padStart(2, '0')}:00`;

      // Chèn vé vào bảng tickets
      insertTicket.run(
        ticketCode,
        hoayenProject.id,
        hoayenProject.name,
        null, // vehicle_id
        plate,
        suppId,
        suppName,
        matId,
        matName,
        cfg.defaultUnit,
        timeIn,
        timeOut,
        0, 0, 0, // length, width, height
        parseFloat(stdVol.toFixed(2)),
        parseFloat(actualVol.toFixed(2)),
        isAdjusted,
        adjustReason,
        'CHECKED_OUT', // Đã xuất bến / hoàn tất
        'Thủ kho Hòa Yên (Import)',
        combinedNotes
      );

      totalImported++;
      totalVolImported += actualVol;
      sheetTrips++;
    }

    console.log(`[Sheet ${cfg.sheetName}] Đã nạp thành công: ${sheetTrips} chuyến`);
  });

  db.exec("COMMIT;");
  console.log(`\n======================================================`);
  console.log(`HOÀN TẤT NẠP DỮ LIỆU DỰ ÁN HÒA YÊN!`);
  console.log(`- Tổng số chuyến xe: ${totalImported}`);
  console.log(`- Tổng khối lượng: ${totalVolImported.toFixed(2)} m³`);
  console.log(`- Số dự án hiện có trong hệ thống: ${db.prepare('SELECT COUNT(*) as count FROM projects').get().count}`);
  console.log(`======================================================`);
} catch (err) {
  db.exec("ROLLBACK;");
  console.error("Lỗi khi nạp dữ liệu:", err);
  throw err;
}
