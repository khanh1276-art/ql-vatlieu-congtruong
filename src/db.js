// Quản lý cơ sở dữ liệu SQLite cho phần mềm Xuất Nhập Kho Vật Liệu Xây Dựng
// Hỗ trợ Đa Dự Án (Multi-project), Đa Đơn Vị Tính & Phân Quyền Tài Khoản (Admin vs Công trường)

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

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

// Hàm băm mật khẩu an toàn bằng SHA256 kèm muối cố định
function hashPassword(password) {
  const salt = 'vlxd_site_salt_2026';
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

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

    -- Bảng Tài Khoản Người Dùng & Phân Quyền
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'SITE_USER', -- 'ADMIN' (Văn phòng) hoặc 'SITE_USER' (Công trường)
      project_id INTEGER,
      status TEXT DEFAULT 'ACTIVE',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    -- Bảng Phiên Đăng Nhập (Sessions)
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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

  migrateSchema();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_time_in ON tickets(time_in);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_supplier ON tickets(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_material ON tickets(material_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_plate ON tickets(plate_number);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  `);

  seedDefaultData();
  seedUsers();
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
  const countProjects = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
  if (countProjects === 0) {
    const insertProj = db.prepare(`
      INSERT INTO projects (code, name, location, status, notes)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertProj.run('DA-VINHTUY2', 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', 'Hà Nội', 'ACTIVE', 'Công trình giao thông trọng điểm');
    insertProj.run('DA-ECOPARK', 'Khu đô thị Sinh thái Ven Sông - Phân khu B', 'Hưng Yên', 'ACTIVE', 'Xây dựng hạ tầng kỹ thuật và khu cao tầng');
    insertProj.run('DA-HAIPHONG', 'Nhà xưởng Công nghiệp VSIP Hải Phòng', 'Hải Phòng', 'ACTIVE', 'Thi công móng và kết cấu thép nhà xưởng');

    db.exec(`
      UPDATE tickets 
      SET project_id = 1, project_name = 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', unit = COALESCE(unit, 'm³')
      WHERE project_id IS NULL;
    `);
  }

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
  }

  const countSuppliers = db.prepare('SELECT COUNT(*) as count FROM suppliers').get().count;
  if (countSuppliers === 0) {
    const insertSupplier = db.prepare(`
      INSERT INTO suppliers (code, name, phone, contact_person, notes)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertSupplier.run('NCC-SONGDA', 'Công ty CP Cung ứng VLXD Sông Đà', '0912.345.678', 'Nguyễn Văn Tuấn', 'Cát bê tông, đá dăm, cống bê tông');
    insertSupplier.run('NCC-HOANGLONG', 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', '0987.654.321', 'Trần Văn Hùng', 'Đá mỏ Hà Nam, thép Hòa Phát');
    insertSupplier.run('NCC-TIENPHAT', 'Doanh nghiệp Tư nhân Vận tải Tiến Phát', '0905.112.233', 'Lê Văn Hưng', 'Cát san lấp, đất đắp công trình');
  }
}

// Khởi tạo các tài khoản người dùng mặc định (Admin + 3 công trường)
function seedUsers() {
  const countUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (countUsers > 0) return;

  console.log('Đang khởi tạo danh sách tài khoản phân quyền mặc định...');

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role, project_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // 1. Tài khoản Admin Văn Phòng (quản lý toàn bộ)
  insertUser.run(
    'admin',
    hashPassword('admin@123'),
    'Quản Trị Viên (Văn Phòng)',
    'ADMIN',
    null,
    'ACTIVE'
  );

  // 2. Tài khoản Công trường 1 (Cầu Vĩnh Tuy 2)
  insertUser.run(
    'congtruong1',
    hashPassword('123456'),
    'Trực Cổng - Cầu Vĩnh Tuy 2',
    'SITE_USER',
    1,
    'ACTIVE'
  );

  // 3. Tài khoản Công trường 2 (KĐT Sinh Thái)
  insertUser.run(
    'congtruong2',
    hashPassword('123456'),
    'Trực Cổng - KĐT Sinh Thái',
    'SITE_USER',
    2,
    'ACTIVE'
  );

  // 4. Tài khoản Công trường 3 (VSIP Hải Phòng)
  insertUser.run(
    'congtruong3',
    hashPassword('123456'),
    'Trực Cổng - VSIP Hải Phòng',
    'SITE_USER',
    3,
    'ACTIVE'
  );

  console.log('Đã tạo thành công tài khoản: admin, congtruong1, congtruong2, congtruong3!');
}

// Khởi chạy tạo bảng và nâng cấp
initSchema();

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  initSchema
};
