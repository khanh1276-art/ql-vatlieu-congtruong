// Quản lý cơ sở dữ liệu SQLite cho phần mềm Xuất Nhập Kho Vật Liệu Xây Dựng
// Hỗ trợ Đa Dự Án (Multi-project) & Đa Đơn Vị Tính (Tấn, m dài, m³, cái...)

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'inventory.db');
const db = new DatabaseSync(DB_PATH);

// Tối ưu hóa hiệu năng với WAL mode
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

function initSchema() {
  db.exec(`
    -- Bảng Dự Án / Công Trường
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      status TEXT DEFAULT 'ACTIVE',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    -- Bảng Nhà cung cấp
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      contact_person TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    -- Bảng Loại vật liệu (Hỗ trợ đa đơn vị tính: m³, Tấn, m, kg, Cái, Bao...)
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      unit TEXT DEFAULT 'm³',
      description TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    -- Bảng Danh mục xe & Quy chuẩn kích thước / khối lượng cố định
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate_number TEXT UNIQUE NOT NULL,
      model_type TEXT,
      supplier_id INTEGER,
      project_id INTEGER,
      length REAL DEFAULT 0,
      width REAL DEFAULT 0,
      height REAL DEFAULT 0,
      standard_volume REAL NOT NULL DEFAULT 0,
      unit TEXT DEFAULT 'm³',
      default_material_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (default_material_id) REFERENCES materials(id) ON DELETE SET NULL
    );

    -- Bảng Phiếu xe vào/ra (Nhập kho vật liệu)
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT UNIQUE NOT NULL,
      project_id INTEGER,
      project_name TEXT,
      vehicle_id INTEGER,
      plate_number TEXT NOT NULL,
      supplier_id INTEGER,
      supplier_name TEXT NOT NULL,
      material_id INTEGER,
      material_name TEXT NOT NULL,
      unit TEXT DEFAULT 'm³',
      time_in TEXT NOT NULL,
      time_out TEXT,
      length REAL DEFAULT 0,
      width REAL DEFAULT 0,
      height REAL DEFAULT 0,
      standard_volume REAL NOT NULL DEFAULT 0,
      actual_volume REAL NOT NULL DEFAULT 0,
      is_manual_adjusted INTEGER DEFAULT 0,
      adjustment_reason TEXT,
      status TEXT DEFAULT 'IN_YARD',
      created_by TEXT DEFAULT 'Thủ kho / Cán bộ trực cổng',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
    );
  `);

  // Migration tự động bổ sung cột nếu bảng cũ tồn tại
  migrateSchema();

  // Tạo index sau khi đã đảm bảo các cột tồn tại
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_time_in ON tickets(time_in);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_supplier ON tickets(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_material ON tickets(material_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_plate ON tickets(plate_number);
  `);

  seedDefaultData();
}

function migrateSchema() {
  const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map(c => c.name);
  if (!ticketCols.includes('project_id')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN project_id INTEGER;`);
  }
  if (!ticketCols.includes('project_name')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN project_name TEXT;`);
  }
  if (!ticketCols.includes('unit')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN unit TEXT DEFAULT 'm³';`);
  }

  const vehicleCols = db.prepare('PRAGMA table_info(vehicles)').all().map(c => c.name);
  if (!vehicleCols.includes('project_id')) {
    db.exec(`ALTER TABLE vehicles ADD COLUMN project_id INTEGER;`);
  }
  if (!vehicleCols.includes('unit')) {
    db.exec(`ALTER TABLE vehicles ADD COLUMN unit TEXT DEFAULT 'm³';`);
  }
}

function seedDefaultData() {
  // 1. Thêm Dự Án / Công Trường mẫu nếu bảng rỗng
  const countProjects = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
  if (countProjects === 0) {
    console.log('Đang khởi tạo danh mục Dự Án / Công Trường...');
    const insertProj = db.prepare(`
      INSERT INTO projects (code, name, location, status, notes)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertProj.run('DA-VINHTUY2', 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', 'Hà Nội', 'ACTIVE', 'Công trình giao thông trọng điểm');
    insertProj.run('DA-ECOPARK', 'Khu đô thị Sinh thái Ven Sông - Phân khu B', 'Hưng Yên', 'ACTIVE', 'Xây dựng hạ tầng kỹ thuật và khu cao tầng');
    insertProj.run('DA-HAIPHONG', 'Nhà xưởng Công nghiệp VSIP Hải Phòng', 'Hải Phòng', 'ACTIVE', 'Thi công móng và kết cấu thép nhà xưởng');

    // Cập nhật các vé cũ (nếu có) vào dự án 1
    db.exec(`
      UPDATE tickets 
      SET project_id = 1, project_name = 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', unit = COALESCE(unit, 'm³')
      WHERE project_id IS NULL;
    `);
  }

  // 2. Thêm Loại vật liệu Thép (Tấn) và Cống bê tông (m dài) nếu chưa có
  const checkThep = db.prepare("SELECT id FROM materials WHERE code = 'THEP-CB400'").get();
  if (!checkThep) {
    const insertMat = db.prepare(`
      INSERT INTO materials (code, name, unit, description)
      VALUES (?, ?, ?, ?)
    `);
    insertMat.run('THEP-CB400', 'Thép thanh vằn Hòa Phát CB400 D10-D25', 'Tấn', 'Thép xây dựng dạng cây, bó nguyên đai');
    insertMat.run('THEP-CUON', 'Thép cuộn D6, D8 Hòa Phát', 'Tấn', 'Thép cuộn tròn trơn rút nguội');
    insertMat.run('CONG-D1000', 'Cống tròn bê tông ly tâm D1000 H10', 'm', 'Cống thoát nước dài 2.5m/đoạn');
    insertMat.run('CONG-HOP16', 'Cống hộp bê tông cốt thép 1.6x1.6m', 'm', 'Cống hộp chịu lực H30 dài 1.5m/đoạn');
    insertMat.run('XIMANG-ROI', 'Xi măng rời mác PCB40 (Xe bồn)', 'Tấn', 'Xi măng trạm trộn bê tông tươi');

    console.log('Đã bổ sung danh mục vật liệu Thép (Tấn), Cống (m dài), Xi măng (Tấn)!');
  }

  // 3. Thêm Xe chuyên chở Thép và Cống nếu chưa có
  const checkXeThep = db.prepare("SELECT id FROM vehicles WHERE plate_number = '29C-771.88'").get();
  if (!checkXeThep) {
    const matThep = db.prepare("SELECT id FROM materials WHERE code = 'THEP-CB400'").get();
    const matCong = db.prepare("SELECT id FROM materials WHERE code = 'CONG-D1000'").get();
    const suppSongDa = db.prepare("SELECT id FROM suppliers WHERE code = 'NCC-SONGDA'").get();
    const suppHoangLong = db.prepare("SELECT id FROM suppliers WHERE code = 'NCC-HOANGLONG'").get();

    const insertVeh = db.prepare(`
      INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, default_material_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Xe đầu kéo chở thép: 30 Tấn
    if (matThep && suppHoangLong) {
      insertVeh.run(
        '29C-771.88', 'Đầu kéo mooc sàn chở thép', suppHoangLong.id, 1,
        12.0, 2.4, 1.5, 30.0, 'Tấn', matThep.id,
        'Định mức cố định 30.0 Tấn thép cây/chuyến'
      );
    }

    // Xe cẩu thùng chở cống bê tông: 12.5 m (5 đốt cống x 2.5m)
    if (matCong && suppSongDa) {
      insertVeh.run(
        '29H-445.67', 'Xe tải gắn cẩu chở cống', suppSongDa.id, 2,
        8.5, 2.35, 0.8, 12.5, 'm', matCong.id,
        'Mỗi chuyến chở 5 đốt cống 2.5m = 12.5 mét dài'
      );
    }

    console.log('Đã tạo xe mẫu chở Thép (30 Tấn) và Cống bê tông (12.5 m)!');
  }

  // Cập nhật các vé cũ (nếu có) có unit chuẩn
  db.exec(`
    UPDATE tickets SET unit = 'm³' WHERE unit IS NULL OR unit = '';
    UPDATE vehicles SET unit = 'm³' WHERE unit IS NULL OR unit = '';
  `);
}

// Khởi chạy tạo bảng và nâng cấp
initSchema();

module.exports = {
  db,
  initSchema
};
