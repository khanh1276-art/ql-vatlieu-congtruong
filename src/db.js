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

    -- Bảng Cài Đặt Hệ Thống (Lưu API Key Gemini, Cấu hình Hybrid OCR, v.v.)
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
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

  cleanSampleProjects();

  const loadedFromSeed = seedFromInitialJsonIfAvailable();
  if (!loadedFromSeed) {
    seedDefaultData();
    seedUsers();
  }
  ensureDefaultUsersAndTickets();
}

function cleanSampleProjects() {
  try {
    const projs = db.prepare(`
      SELECT id, code, name FROM projects 
      WHERE code IN ('DA-VINHTUY2', 'DA-ECOPARK', 'DA-HAIPHONG')
         OR name LIKE '%Cầu Vĩnh Tuy 2%'
         OR name LIKE '%Sinh thái Ven Sông%'
         OR name LIKE '%VSIP Hải Phòng%'
    `).all();

    if (projs.length > 0) {
      const pIds = projs.map(p => p.id);
      const ph = pIds.map(() => '?').join(',');

      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN TRANSACTION;');

      db.prepare(`DELETE FROM tickets WHERE project_id IN (${ph})`).run(...pIds);
      db.prepare(`DELETE FROM vehicles WHERE project_id IN (${ph})`).run(...pIds);
      db.prepare(`
        DELETE FROM users 
        WHERE project_id IN (${ph}) 
           OR username IN ('congtruong1', 'congtruong2', 'congtruong3')
      `).run(...pIds);
      db.prepare(`DELETE FROM projects WHERE id IN (${ph})`).run(...pIds);

      db.exec('COMMIT;');
      db.exec('PRAGMA foreign_keys = ON;');
      console.log(`[CLEANUP] Đã xóa thành công ${projs.length} dự án ví dụ và toàn bộ dữ liệu mẫu liên quan.`);
    }

    // Xóa triệt để người dùng công trường mẫu nếu còn
    db.prepare(`DELETE FROM users WHERE username IN ('congtruong1', 'congtruong2', 'congtruong3')`).run();

    // Đồng bộ các phiếu về đúng dự án Hòa Yên nếu có sai lệch ID giữa 4 và 5
    const hoaYenProj = db.prepare("SELECT id, name FROM projects WHERE name LIKE '%Hòa Yên%' OR code LIKE '%HOAYEN%' ORDER BY id ASC LIMIT 1").get();
    if (hoaYenProj) {
      db.prepare(`UPDATE tickets SET project_id = ?, project_name = ? WHERE (project_id = 4 OR project_id = 5) AND project_id != ?`).run(hoaYenProj.id, hoaYenProj.name, hoaYenProj.id);
    }
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (rb) {}
    try { db.exec('PRAGMA foreign_keys = ON;'); } catch (fk) {}
    console.warn('[CLEANUP] Lỗi dọn dẹp dự án ví dụ:', err.message);
  }
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
  if (!ticketCols.includes('plate_image')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN plate_image TEXT;`);
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
    insertProj.run('J.0099 - HOAYEN', 'Dự án KCN Hòa Yên', 'Hòa Yên', 'ACTIVE', 'Dự án KCN Hòa Yên');
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

// Khởi tạo các tài khoản người dùng mặc định (Admin + Điều hành)
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

  console.log('Đã tạo thành công danh sách tài khoản mặc định!');
}

function seedFromInitialJsonIfAvailable(force = false) {
  const candidatePaths = [
    path.join(__dirname, '..', 'data_seed', 'initial_seed.json'),
    path.join(__dirname, '..', 'data', 'initial_seed.json'),
    path.join(__dirname, 'initial_seed.json'),
    path.join(process.cwd(), 'data_seed', 'initial_seed.json'),
    path.join(process.cwd(), 'data', 'initial_seed.json')
  ];
  let seedPath = candidatePaths.find(p => fs.existsSync(p));
  if (!seedPath) {
    console.warn('[SEED] Không tìm thấy tệp initial_seed.json ở bất kỳ đường dẫn nào:', candidatePaths);
    return {
      success: false,
      error: 'File not found',
      searched: candidatePaths
    };
  }

  try {
    const destData = path.join(__dirname, '..', 'data', 'initial_seed.json');
    if (!fs.existsSync(destData)) {
      try { fs.copyFileSync(seedPath, destData); } catch (copyErr) {}
    }

    const raw = fs.readFileSync(seedPath, 'utf8');
    const data = JSON.parse(raw);

    // 1. Projects
    const insProj = db.prepare(`
      INSERT OR IGNORE INTO projects (id, code, name, location, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of data.projects || []) {
      insProj.run(p.id, p.code, p.name, p.location || '', p.status || 'ACTIVE', p.notes || '', p.created_at || null);
    }

    // Xác định chính xác project Hòa Yên trong DB hiện tại (dù id là 4 hay 5)
    const hoaYenProj = db.prepare("SELECT id, name FROM projects WHERE name LIKE '%Hòa Yên%' OR code LIKE '%HOAYEN%' ORDER BY id ASC LIMIT 1").get();
    const hyId = hoaYenProj ? hoaYenProj.id : 4;
    const hyName = hoaYenProj ? hoaYenProj.name : 'Dự án KCN Hòa Yên';

    // 2. Suppliers
    const insSupp = db.prepare(`
      INSERT OR IGNORE INTO suppliers (id, code, name, phone, contact_person, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of data.suppliers || []) {
      insSupp.run(s.id, s.code, s.name, s.phone || '', s.contact_person || '', s.notes || '', s.created_at || null);
    }

    // Đảm bảo NCC Đức Phúc (ĐP) luôn có mặt
    let checkDP = db.prepare("SELECT id FROM suppliers WHERE code = 'NCC-DUCPHUC' OR name LIKE '%Đức Phúc%'").get();
    let ducPhucId = checkDP ? checkDP.id : 12;
    if (!checkDP) {
      try {
        const resDP = db.prepare(`
          INSERT INTO suppliers (code, name, notes, created_at)
          VALUES ('NCC-DUCPHUC', 'Công ty TNHH Đức Phúc (ĐP)', 'Cung cấp Đất san lấp - Hòa Yên (Ký hiệu DAT-ĐP)', '2026-09-24 14:59:46')
        `).run();
        ducPhucId = resDP.lastInsertRowid;
      } catch (e) {
        const dpFallback = db.prepare("SELECT id FROM suppliers WHERE name LIKE '%Đức Phúc%' LIMIT 1").get();
        if (dpFallback) ducPhucId = dpFallback.id;
      }
    }

    const suppMap = {};
    db.prepare('SELECT id, name, code FROM suppliers').all().forEach(s => {
      if (s.code) suppMap[s.code] = s.id;
      if (s.name) suppMap[s.name] = s.id;
    });

    // 3. Materials
    const insMat = db.prepare(`
      INSERT OR IGNORE INTO materials (id, code, name, unit, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const m of data.materials || []) {
      insMat.run(m.id, m.code, m.name, m.unit || 'm³', m.description || '', m.created_at || null);
    }

    const matSanLap = db.prepare("SELECT id FROM materials WHERE code = 'DAT-SANLAP' OR name LIKE '%Đất san lấp%' LIMIT 1").get();
    const datSanLapId = matSanLap ? matSanLap.id : 12;

    // 4. Vehicles
    const insVeh = db.prepare(`
      INSERT OR IGNORE INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, default_material_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of data.vehicles || []) {
      let sId = v.supplier_id;
      if (v.supplier_name && suppMap[v.supplier_name]) sId = suppMap[v.supplier_name];
      insVeh.run(v.plate_number, v.model_type || '', sId || null, hyId, v.length || 0, v.width || 0, v.height || 0, v.standard_volume || 0, v.unit || 'm³', datSanLapId, v.notes || '', v.created_at || null);
    }

    // 5. Users
    const insUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, project_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const u of data.users || []) {
      insUser.run(u.id, u.username, u.password_hash, u.full_name || '', u.role || 'SITE_USER', u.project_id || null, u.status || 'ACTIVE', u.created_at || null);
    }

    // 6. Tickets - Cập nhật khối lượng đối soát cho vé đã có và nạp bổ sung toàn bộ vé mới
    const existingTicketsMap = new Map();
    db.prepare('SELECT ticket_code, actual_volume, standard_volume FROM tickets').all().forEach(r => {
      existingTicketsMap.set(r.ticket_code, r);
    });

    const ticketsToUpdate = [];
    const ticketsToInsert = [];

    for (const t of data.tickets || []) {
      const ex = existingTicketsMap.get(t.ticket_code);
      if (ex) {
        const oldAct = Math.round((Number(ex.actual_volume) || 0) * 100) / 100;
        const newAct = Math.round((Number(t.actual_volume) || 0) * 100) / 100;
        const oldStd = Math.round((Number(ex.standard_volume) || 0) * 100) / 100;
        const newStd = Math.round((Number(t.standard_volume) || 0) * 100) / 100;
        if (Math.abs(oldAct - newAct) > 0.001 || Math.abs(oldStd - newStd) > 0.001) {
          ticketsToUpdate.push(t);
        }
      } else {
        ticketsToInsert.push(t);
      }
    }

    if (ticketsToUpdate.length > 0 || ticketsToInsert.length > 0) {
      console.log(`[SEED] Cập nhật ${ticketsToUpdate.length} vé thay đổi khối lượng và nạp ${ticketsToInsert.length} vé mới vào DB (Hòa Yên ID = ${hyId})...`);
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN TRANSACTION;');

      if (ticketsToUpdate.length > 0) {
        const updTicket = db.prepare(`
          UPDATE tickets
          SET actual_volume = ?, standard_volume = ?, is_manual_adjusted = 1,
              adjustment_reason = 'Cập nhật khối lượng đối soát từ OneDrive (Sổ theo dõi Hòa Yên)'
          WHERE ticket_code = ?
        `);
        for (const t of ticketsToUpdate) {
          updTicket.run(t.actual_volume, t.standard_volume, t.ticket_code);
        }
        console.log(`[SEED] Đã cập nhật thành công khối lượng cho ${ticketsToUpdate.length} phiếu!`);
      }

      if (ticketsToInsert.length > 0) {
        const insTicket = db.prepare(`
          INSERT INTO tickets (
            ticket_code, project_id, project_name, vehicle_id, plate_number,
            supplier_id, supplier_name, material_id, material_name, unit,
            time_in, time_out, length, width, height, standard_volume, actual_volume,
            is_manual_adjusted, adjustment_reason, status, created_by, notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const matMap = {};
        db.prepare('SELECT id, name, code FROM materials').all().forEach(m => {
          if (m.code) matMap[m.code] = m.id;
          if (m.name) matMap[m.name] = m.id;
        });

        for (const t of ticketsToInsert) {
          const isHoaYen = !t.project_id || t.project_id === 4 || t.project_id === 5 || (t.project_name && t.project_name.includes('Hòa Yên'));
          const pId = isHoaYen ? hyId : t.project_id;
          const pName = isHoaYen ? hyName : t.project_name;
          
          let suppId = t.supplier_id;
          if (t.supplier_name && suppMap[t.supplier_name]) {
            suppId = suppMap[t.supplier_name];
          } else if (t.supplier_name && t.supplier_name.includes('Đức Phúc')) {
            suppId = ducPhucId;
          }

          let matId = t.material_id;
          if (t.material_name && matMap[t.material_name]) {
            matId = matMap[t.material_name];
          } else if (!matId) {
            matId = datSanLapId;
          }

          insTicket.run(
            t.ticket_code, pId, pName, t.vehicle_id || null, t.plate_number,
            suppId || null, t.supplier_name || '', matId, t.material_name || 'Đất san lấp / Đất đắp', t.unit || 'm³',
            t.time_in, t.time_out || null, t.length || 0, t.width || 0, t.height || 0, t.standard_volume || 0, t.actual_volume || 0,
            t.is_manual_adjusted ? 1 : 0, t.adjustment_reason || '', t.status || 'CHECKED_OUT', t.created_by || 'Thủ kho Hòa Yên (OneDrive Sync)', t.notes || '', t.created_at || t.time_in
          );
        }
        console.log(`[SEED] Đã nạp thành công ${ticketsToInsert.length} phiếu mới!`);
      }

      db.exec('COMMIT;');
      db.exec('PRAGMA foreign_keys = ON;');
    } else {
      console.log('[SEED] Tất cả phiếu trong initial_seed.json đã đồng bộ với DB (khối lượng và số lượng đầy đủ).');
    }

    const totalNow = db.prepare('SELECT COUNT(*) as count FROM tickets').get().count;
    console.log(`[SEED] Tổng số phiếu hiện có trong DB: ${totalNow}`);
    return {
      success: true,
      updatedCount: ticketsToUpdate.length,
      insertedCount: ticketsToInsert.length,
      totalTickets: totalNow,
      hoaYenId: hyId
    };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (rbErr) {}
    try { db.exec('PRAGMA foreign_keys = ON;'); } catch (fkErr) {}
    console.error('[SEED] Lỗi khi nạp initial_seed.json:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

function ensureDefaultUsersAndTickets() {
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
}

// Khởi chạy tạo bảng và nâng cấp
initSchema();

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  initSchema,
  seedFromInitialJsonIfAvailable
};
