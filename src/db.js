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

try {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
} catch (e) {
  console.warn('[DB] Pragma notice:', e.message);
}

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
      role TEXT NOT NULL DEFAULT 'SITE_USER', -- 'ADMIN' (Văn phòng), 'MODERATOR' (Quản lý/Điều hành), 'SITE_USER' (Công trường)
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
  ensureDefaultUsersAndTickets();
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

  const countVehicles = db.prepare('SELECT COUNT(*) as count FROM vehicles').get().count;
  if (countVehicles === 0) {
    const insertVeh = db.prepare(`
      INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertVeh.run('29C-771.88', 'Howo 4 chân', 2, 1, 12, 2.4, 1.5, 30, 'Tấn', 'Xe thùng dài chở thép');
    insertVeh.run('29C-881.23', 'Dongfeng 3 chân', 1, 1, 5.0, 2.3, 0.87, 10, 'm³', 'Xe ben chở cát');
    insertVeh.run('29H-723.45', 'Hino 3 chân', 2, 1, 5.8, 2.3, 1.05, 14, 'm³', 'Xe ben chở cát đá');
    insertVeh.run('29C-912.68', 'Howo 4 chân', 2, 1, 6.0, 2.3, 1.09, 15, 'm³', 'Xe ben chở cát đá');
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

  // 2. Tài khoản Cán Bộ Điều Hành / Giám Sát (Moderator - sửa số liệu mọi ngày, không xóa)
  insertUser.run(
    'dieuhanh',
    hashPassword('123456'),
    'Cán Bộ Điều Hành / Giám Sát',
    'MODERATOR',
    null,
    'ACTIVE'
  );

  // 3. Tài khoản Công trường 1 (Cầu Vĩnh Tuy 2)
  insertUser.run(
    'congtruong1',
    hashPassword('123456'),
    'Trực Cổng - Cầu Vĩnh Tuy 2',
    'SITE_USER',
    1,
    'ACTIVE'
  );

  // 4. Tài khoản Công trường 2 (KĐT Sinh Thái)
  insertUser.run(
    'congtruong2',
    hashPassword('123456'),
    'Trực Cổng - KĐT Sinh Thái',
    'SITE_USER',
    2,
    'ACTIVE'
  );

  // 5. Tài khoản Công trường 3 (VSIP Hải Phòng)
  insertUser.run(
    'congtruong3',
    hashPassword('123456'),
    'Trực Cổng - VSIP Hải Phòng',
    'SITE_USER',
    3,
    'ACTIVE'
  );

  console.log('Đã tạo thành công danh sách tài khoản mặc định!');
}

function seedFromInitialJsonIfAvailable() {
  const seedPath = path.join(__dirname, '..', 'data', 'initial_seed.json');
  if (!fs.existsSync(seedPath)) return false;

  const countTickets = db.prepare('SELECT COUNT(*) as count FROM tickets').get().count;
  if (countTickets > 100) return true;

  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    const data = JSON.parse(raw);
    console.log('[SEED] Đang nạp dữ liệu từ data/initial_seed.json...');

    db.exec('BEGIN');

    // Projects
    const insProj = db.prepare(`
      INSERT OR IGNORE INTO projects (id, code, name, location, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of data.projects || []) {
      insProj.run(p.id, p.code, p.name, p.location || '', p.status || 'ACTIVE', p.notes || '', p.created_at || null);
    }

    // Suppliers
    const insSupp = db.prepare(`
      INSERT OR IGNORE INTO suppliers (id, code, name, phone, contact_person, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of data.suppliers || []) {
      insSupp.run(s.id, s.code, s.name, s.phone || '', s.contact_person || '', s.notes || '', s.created_at || null);
    }

    // Materials
    const insMat = db.prepare(`
      INSERT OR IGNORE INTO materials (id, code, name, unit, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const m of data.materials || []) {
      insMat.run(m.id, m.code, m.name, m.unit || 'm³', m.description || '', m.created_at || null);
    }

    // Vehicles
    const insVeh = db.prepare(`
      INSERT OR IGNORE INTO vehicles (id, plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, default_material_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of data.vehicles || []) {
      insVeh.run(v.id, v.plate_number, v.model_type || '', v.supplier_id || null, v.project_id || null, v.length || 0, v.width || 0, v.height || 0, v.standard_volume || 0, v.unit || 'm³', v.default_material_id || null, v.notes || '', v.created_at || null);
    }

    // Users
    const insUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, project_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const u of data.users || []) {
      insUser.run(u.id, u.username, u.password_hash, u.full_name || '', u.role || 'SITE_USER', u.project_id || null, u.status || 'ACTIVE', u.created_at || null);
    }

    // Tickets
    const insTicket = db.prepare(`
      INSERT OR IGNORE INTO tickets (
        id, ticket_code, project_id, project_name, vehicle_id, plate_number,
        supplier_id, supplier_name, material_id, material_name, unit,
        time_in, time_out, length, width, height, standard_volume, actual_volume,
        is_manual_adjusted, adjustment_reason, status, created_by, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of data.tickets || []) {
      insTicket.run(
        t.id, t.ticket_code, t.project_id || null, t.project_name || '', t.vehicle_id || null, t.plate_number,
        t.supplier_id || null, t.supplier_name || '', t.material_id || null, t.material_name || '', t.unit || 'm³',
        t.time_in, t.time_out || null, t.length || 0, t.width || 0, t.height || 0, t.standard_volume || 0, t.actual_volume || 0,
        t.is_manual_adjusted ? 1 : 0, t.adjustment_reason || '', t.status || 'COMPLETED', t.created_by || 'Hệ thống', t.notes || '', t.created_at || t.time_in
      );
    }

    db.exec('COMMIT');
    console.log(`[SEED] Đã nạp thành công ${(data.tickets || []).length} phiếu từ initial_seed.json!`);
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[SEED] Lỗi khi nạp initial_seed.json:', err.message);
    return false;
  }
}

function ensureDefaultUsersAndTickets() {
  const loaded = seedFromInitialJsonIfAvailable();
  if (loaded) return;

  // Đảm bảo tài khoản Quản lý / Điều hành mặc định luôn tồn tại
  const checkMod = db.prepare("SELECT * FROM users WHERE username = 'dieuhanh'").get();
  if (!checkMod) {
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, project_id, status)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE')
    `).run('dieuhanh', hashPassword('123456'), 'Cán Bộ Điều Hành / Giám Sát', 'MODERATOR', null);
  } else if (checkMod.role !== 'MODERATOR' || !verifyPassword('123456', checkMod.password_hash)) {
    db.prepare("UPDATE users SET role = 'MODERATOR', password_hash = ? WHERE username = 'dieuhanh'").run(hashPassword('123456'));
  }

  // Đảm bảo các tài khoản công trường mặc định có đầy đủ project_id và mật khẩu chuẩn
  const checkCt1 = db.prepare("SELECT * FROM users WHERE username = 'congtruong1'").get();
  if (checkCt1 && (checkCt1.project_id !== 1 || !verifyPassword('123456', checkCt1.password_hash))) {
    db.prepare("UPDATE users SET project_id = 1, password_hash = ? WHERE username = 'congtruong1'").run(hashPassword('123456'));
  }

  const checkCt2 = db.prepare("SELECT * FROM users WHERE username = 'congtruong2'").get();
  if (checkCt2 && (checkCt2.project_id !== 2 || !verifyPassword('123456', checkCt2.password_hash))) {
    db.prepare("UPDATE users SET project_id = 2, password_hash = ? WHERE username = 'congtruong2'").run(hashPassword('123456'));
  }

  const checkCt3 = db.prepare("SELECT * FROM users WHERE username = 'congtruong3'").get();
  if (checkCt3 && (checkCt3.project_id !== 3 || !verifyPassword('123456', checkCt3.password_hash))) {
    db.prepare("UPDATE users SET project_id = 3, password_hash = ? WHERE username = 'congtruong3'").run(hashPassword('123456'));
  }

  seedSampleTickets();
}

function seedSampleTickets() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const insertTicket = db.prepare(`
    INSERT INTO tickets (
      ticket_code, project_id, project_name, vehicle_id, plate_number,
      supplier_id, supplier_name, material_id, material_name, unit,
      time_in, time_out, length, width, height, standard_volume, actual_volume,
      is_manual_adjusted, adjustment_reason, status, created_by, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ==================== 1. KHỞI TẠO PHIẾU CHO DỰ ÁN 1 (CẦU VĨNH TUY 2) ====================
  const countP1 = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = 1').get().count;
  if (countP1 === 0) {
    console.log('Khởi tạo phiếu mẫu cho Dự án 1 (Cầu Vĩnh Tuy 2)...');
    const v1 = db.prepare("SELECT * FROM vehicles WHERE plate_number = '29C-771.88'").get();
    const v2 = db.prepare("SELECT * FROM vehicles WHERE plate_number = '29C-881.23'").get();
    const v3 = db.prepare("SELECT * FROM vehicles WHERE plate_number = '29H-723.45'").get();
    const v4 = db.prepare("SELECT * FROM vehicles WHERE plate_number = '29C-912.68'").get();

    const mThep = db.prepare("SELECT * FROM materials WHERE code = 'THEP-CUON'").get();
    const mCat = db.prepare("SELECT * FROM materials WHERE code = 'CAT-VANG'").get();
    const mDa1 = db.prepare("SELECT * FROM materials WHERE code = 'DA-1X2'").get();
    const mDa4 = db.prepare("SELECT * FROM materials WHERE code = 'DA-4X6'").get();
    const mCatSan = db.prepare("SELECT * FROM materials WHERE code = 'CAT-SANLAP'").get();

    if (mThep) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0001`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v1?.id || null, '29C-771.88', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mThep.id, mThep.name, mThep.unit, `${todayStr} 07:15:00`, `${todayStr} 07:45:00`, 12, 2.4, 1.5, 30, 30, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Thép móng trụ P12');
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0002`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v1?.id || null, '29C-771.88', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mThep.id, mThep.name, mThep.unit, `${todayStr} 13:20:00`, `${todayStr} 13:55:00`, 12, 2.4, 1.5, 30, 30, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Thép dầm trụ P13');
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0003`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v1?.id || null, '29C-771.88', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mThep.id, mThep.name, mThep.unit, `${todayStr} 16:10:00`, `${todayStr} 16:40:00`, 12, 2.4, 1.5, 30, 30, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Thép mũ mố M1');
    }
    if (mCat) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0004`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v2?.id || null, '29C-881.23', 1, 'Công ty CP Cung ứng VLXD Sông Đà', mCat.id, mCat.name, mCat.unit, `${todayStr} 08:30:00`, `${todayStr} 09:10:00`, 5.0, 2.3, 0.87, 10, 10, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Cát trạm trộn');
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0005`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v3?.id || null, '29H-723.45', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mCat.id, mCat.name, mCat.unit, `${todayStr} 09:40:00`, `${todayStr} 10:20:00`, 5.8, 2.3, 1.05, 14, 14, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Cát đúc dầm');
      // 1 xe đang trong bãi
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0006`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v4?.id || null, '29C-912.68', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mCat.id, mCat.name, mCat.unit, `${todayStr} 17:00:00`, null, 6.0, 2.3, 1.09, 15, 15, 0, null, 'IN_YARD', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Đang chờ dỡ cát bãi 2');
    }
    if (mDa1) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0007`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v3?.id || null, '29H-723.45', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mDa1.id, mDa1.name, mDa1.unit, `${todayStr} 10:50:00`, `${todayStr} 11:30:00`, 5.8, 2.3, 1.05, 14, 14, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Đá trạm trộn bê tông');
    }
    if (mDa4) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0008`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v4?.id || null, '29C-912.68', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', mDa4.id, mDa4.name, mDa4.unit, `${todayStr} 14:15:00`, `${todayStr} 14:50:00`, 6.0, 2.3, 1.09, 15, 15, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Đá lót móng');
    }
    if (mCatSan) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0009`, 1, 'Dự án Cầu Vĩnh Tuy 2 - Gói thầu 03', v2?.id || null, '29C-881.23', 1, 'Công ty CP Cung ứng VLXD Sông Đà', mCatSan.id, mCatSan.name, mCatSan.unit, `${todayStr} 15:30:00`, `${todayStr} 16:05:00`, 5.0, 2.3, 0.87, 10, 10, 0, null, 'COMPLETED', 'Trực Cổng - Cầu Vĩnh Tuy 2', 'Cát tôn nền đường dẫn');
    }
  }

  // ==================== 2. KHỞI TẠO PHIẾU CHO DỰ ÁN 2 (KĐT SINH THÁI) ====================
  const countP2 = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = 2').get().count;
  if (countP2 === 0) {
    console.log('Khởi tạo phiếu mẫu cho Dự án 2 (KĐT Sinh Thái Ven Sông)...');
    let vCong = db.prepare("SELECT * FROM vehicles WHERE plate_number = '29H-445.67'").get();
    if (!vCong) {
      const resV = db.prepare(`
        INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('29H-445.67', 'Xe tải gắn cẩu chở cống', 1, 2, 8.5, 2.35, 0.8, 12.5, 'm', 'Xe chở cống KĐT');
      vCong = { id: resV.lastInsertRowid };
    }

    const mHop = db.prepare("SELECT * FROM materials WHERE code = 'CONG-HOP16'").get();
    const mTron = db.prepare("SELECT * FROM materials WHERE code = 'CONG-D1000'").get();
    const mDat = db.prepare("SELECT * FROM materials WHERE code = 'DAT-DAP-K95'").get();

    if (mHop) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0011`, 2, 'Khu đô thị Sinh thái Ven Sông - Phân khu B', vCong.id, '29H-445.67', 1, 'Công ty CP Cung ứng VLXD Sông Đà', mHop.id, mHop.name, mHop.unit, `${todayStr} 08:00:00`, `${todayStr} 08:45:00`, 8.5, 2.35, 0.8, 12.5, 12.5, 0, null, 'COMPLETED', 'Trực Cổng - KĐT Sinh Thái', 'Tuyến cống D1 Phân khu B');
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0012`, 2, 'Khu đô thị Sinh thái Ven Sông - Phân khu B', vCong.id, '29H-445.67', 1, 'Công ty CP Cung ứng VLXD Sông Đà', mHop.id, mHop.name, mHop.unit, `${todayStr} 13:30:00`, `${todayStr} 14:15:00`, 8.5, 2.35, 0.8, 12.5, 12.5, 0, null, 'COMPLETED', 'Trực Cổng - KĐT Sinh Thái', 'Tuyến cống D2 Phân khu B');
    }
    if (mTron) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0013`, 2, 'Khu đô thị Sinh thái Ven Sông - Phân khu B', vCong.id, '29H-445.67', 1, 'Công ty CP Cung ứng VLXD Sông Đà', mTron.id, mTron.name, mTron.unit, `${todayStr} 15:00:00`, `${todayStr} 15:40:00`, 8.5, 2.35, 0.8, 12.5, 12.5, 0, null, 'COMPLETED', 'Trực Cổng - KĐT Sinh Thái', 'Cống thoát nước mưa');
    }
    if (mDat) {
      let vDat = db.prepare("SELECT id FROM vehicles WHERE plate_number = '30H-339.81'").get();
      if (!vDat) {
        const resVDat = db.prepare(`
          INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('30H-339.81', 'Xe ben 3 chân chở đất', 1, 2, 5.0, 2.3, 0.74, 8.5, 'm³', 'Xe chở đất san lấp KĐT');
        vDat = { id: resVDat.lastInsertRowid };
      }
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0014`, 2, 'Khu đô thị Sinh thái Ven Sông - Phân khu B', vDat.id, '30H-339.81', 1, 'Công ty CP Cung ứng VLXD Sông Đà', mDat.id, mDat.name, mDat.unit, `${todayStr} 09:15:00`, `${todayStr} 09:50:00`, 5.0, 2.3, 0.74, 8.5, 8.5, 0, null, 'COMPLETED', 'Trực Cổng - KĐT Sinh Thái', 'Đất đắp taluy ven sông');
    }
  }

  // ==================== 3. KHỞI TẠO PHIẾU CHO DỰ ÁN 3 (VSIP HẢI PHÒNG) ====================
  const countP3 = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = 3').get().count;
  if (countP3 === 0) {
    console.log('Khởi tạo phiếu mẫu cho Dự án 3 (VSIP Hải Phòng)...');
    let checkV1 = db.prepare("SELECT id FROM vehicles WHERE plate_number = '15C-345.67'").get();
    let v1Id = checkV1 ? checkV1.id : null;
    if (!v1Id) {
      const resV1 = db.prepare(`
        INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15C-345.67', 'Đầu kéo mooc lồng 4 trục', 2, 3, 12.0, 2.4, 1.5, 32.0, 'Tấn', 'Xe thường trực VSIP Hải Phòng');
      v1Id = resV1.lastInsertRowid;
    }

    let checkV2 = db.prepare("SELECT id FROM vehicles WHERE plate_number = '15C-789.01'").get();
    let v2Id = checkV2 ? checkV2.id : null;
    if (!v2Id) {
      const resV2 = db.prepare(`
        INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('15C-789.01', 'Xe bồn xitec chở xi măng rời', 1, 3, 10.0, 2.3, 2.0, 30.0, 'Tấn', 'Cấp xi măng trạm trộn VSIP');
      v2Id = resV2.lastInsertRowid;
    }

    const matThep = db.prepare("SELECT * FROM materials WHERE code = 'THEP-CB400'").get();
    const matXiMang = db.prepare("SELECT * FROM materials WHERE code = 'XIMANG-ROI'").get();
    const matCat = db.prepare("SELECT * FROM materials WHERE code = 'CAT-VANG'").get();

    if (matThep) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0031`, 3, 'Nhà xưởng Công nghiệp VSIP Hải Phòng', v1Id, '15C-345.67', 2, 'Công ty TNHH Vận tải & Xây dựng Hoàng Long', matThep.id, matThep.name, matThep.unit || 'Tấn', `${todayStr} 08:15:00`, `${todayStr} 08:50:00`, 12.0, 2.4, 1.5, 32.0, 32.0, 0, null, 'COMPLETED', 'Trực Cổng - VSIP Hải Phòng', 'Thép móng xưởng A');
    }
    if (matXiMang) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0032`, 3, 'Nhà xưởng Công nghiệp VSIP Hải Phòng', v2Id, '15C-789.01', 1, 'Công ty CP Cung ứng VLXD Sông Đà', matXiMang.id, matXiMang.name, matXiMang.unit || 'Tấn', `${todayStr} 09:30:00`, `${todayStr} 10:15:00`, 10.0, 2.3, 2.0, 30.0, 30.0, 0, null, 'COMPLETED', 'Trực Cổng - VSIP Hải Phòng', 'Xi măng đổ sàn xưởng B');
    }
    if (matCat) {
      insertTicket.run(`NK-${todayStr.replace(/-/g, '')}-0033`, 3, 'Nhà xưởng Công nghiệp VSIP Hải Phòng', v1Id, '15C-345.67', 3, 'Doanh nghiệp Tư nhân Vận tải Tiến Phát', matCat.id, matCat.name, matCat.unit || 'm³', `${todayStr} 10:45:00`, `${todayStr} 11:20:00`, 8.0, 2.3, 1.0, 14.5, 14.5, 0, null, 'COMPLETED', 'Trực Cổng - VSIP Hải Phòng', 'Cát trạm trộn');
    }
  }

  console.log('Đã kiểm tra và hoàn tất nạp số liệu mẫu cho cả 3 dự án!');
}

// Khởi chạy tạo bảng và nâng cấp
initSchema();

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  initSchema
};
