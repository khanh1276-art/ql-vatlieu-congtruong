// Quản lý đồng bộ và lưu trữ cơ sở dữ liệu trên Cloud (Turso / libSQL)
// Giúp bảo toàn 100% dữ liệu khi chạy trên Render Free (chống mất dữ liệu khi ngủ đông hoặc redeploy)

let libsqlClient = null;
let isCloudActive = false;

function isCloudConfigured() {
  const url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  const token = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  return Boolean(url && token);
}

function getCloudClient() {
  if (!libsqlClient && isCloudConfigured()) {
    let createClient;
    try {
      createClient = require('@libsql/client').createClient;
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        console.log('📦 Phát hiện thiếu thư viện @libsql/client. Đang tự động tải về...');
        try {
          const { execSync } = require('node:child_process');
          execSync('npm install --no-save @libsql/client', { stdio: 'inherit' });
          createClient = require('@libsql/client').createClient;
          console.log('✓ Tự động cài đặt @libsql/client thành công!');
        } catch (installErr) {
          console.error('⚠️ Không thể tự động cài đặt @libsql/client:', installErr.message);
        }
      }
    }

    if (createClient) {
      try {
        let url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
        if (url.startsWith('libsql://')) {
          url = url.replace('libsql://', 'https://');
        }
        const token = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');
        libsqlClient = createClient({
          url: url,
          authToken: token
        });
        isCloudActive = true;
      } catch (err) {
        console.error('⚠️ Không thể khởi tạo kết nối Cloud Turso:', err.message);
        isCloudActive = false;
      }
    }
  }
  return libsqlClient;
}

// Tiện ích bọc Promise kèm Timeout để không bao giờ làm treo tiến trình
function withTimeout(promise, ms, opName = 'Thao tác') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${opName} quá thời gian chờ (${ms}ms)`)), ms))
  ]);
}

// Khởi tạo bảng trên Cloud và đồng bộ dữ liệu ban đầu
async function initCloudDatabase(localDb) {
  if (!isCloudConfigured()) {
    console.log('ℹ️ Chế độ Database: Cục bộ (SQLite Local).');
    return { cloud: false };
  }

  const client = getCloudClient();
  if (!client) return { cloud: false };

  console.log('🔄 Đang kết nối tới Cloud Database (Turso)...');

  try {
    // 1. Tạo các bảng trên Turso nếu chưa có (kèm timeout 15s)
    await withTimeout(client.batch([
      `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        location TEXT,
        status TEXT DEFAULT 'ACTIVE',
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'SITE_USER',
        project_id INTEGER,
        status TEXT DEFAULT 'ACTIVE',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        contact_person TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )`,
      `CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        unit TEXT DEFAULT 'm³',
        description TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )`,
      `CREATE TABLE IF NOT EXISTS vehicles (
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
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )`,
      `CREATE TABLE IF NOT EXISTS tickets (
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
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )`
    ], 'write'), 15000, 'Tạo bảng trên Turso');

    // 2. Kiểm tra xem Cloud đã có dữ liệu chưa
    const checkProjects = await withTimeout(
      client.execute('SELECT COUNT(*) as count FROM projects'),
      10000,
      'Kiểm tra dữ liệu Cloud'
    );
    const cloudCount = Number(checkProjects.rows[0]?.count || 0);

    if (cloudCount > 0) {
      console.log(`☁️ Đã tìm thấy dữ liệu trên Cloud (${cloudCount} dự án). Đang khôi phục vào bộ nhớ máy chủ...`);
      // Kéo dữ liệu từ Cloud về nạp vào SQLite cục bộ của container
      const tables = ['projects', 'suppliers', 'materials', 'vehicles', 'users', 'tickets'];
      localDb.exec('PRAGMA foreign_keys = OFF;');
      localDb.exec('BEGIN TRANSACTION;');

      localDb.isSyncing = true; // Chặn trigger đồng bộ ngược lại Cloud
      try {
        for (const t of tables) {
          const rs = await withTimeout(client.execute(`SELECT * FROM ${t}`), 10000, `Tải bảng ${t}`);
          if (rs.rows.length > 0) {
            const keys = Object.keys(rs.rows[0]);
            const cols = keys.join(', ');
            const qs = keys.map(() => '?').join(', ');
            const stmt = (localDb.originalPrepare || localDb.prepare.bind(localDb))(`INSERT OR REPLACE INTO ${t} (${cols}) VALUES (${qs})`);
            for (const row of rs.rows) {
              stmt.run(...keys.map(k => row[k]));
            }
          }
        }
        localDb.exec('COMMIT;');
        console.log('✓ Hoàn tất nạp dữ liệu từ Cloud vào container. Dữ liệu đã sẵn sàng!');
      } catch (pullErr) {
        localDb.exec('ROLLBACK;');
        console.error('⚠️ Lỗi khi nạp dữ liệu từ Cloud:', pullErr.message);
      } finally {
        localDb.isSyncing = false;
        localDb.exec('PRAGMA foreign_keys = ON;');
      }
    } else {
      console.log('☁️ Cloud Database mới tinh. Đang tải dữ liệu khởi tạo lên Cloud...');
      // Đẩy dữ liệu mẫu từ cục bộ lên Cloud
      await withTimeout(syncAllLocalToCloud(localDb, client), 20000, 'Đồng bộ ban đầu lên Cloud');
      console.log('✓ Đã đồng bộ dữ liệu mẫu lên Cloud thành công!');
    }

    isCloudActive = true;
    return { cloud: true, client };
  } catch (err) {
    isCloudActive = false;
    console.error('❌ Lỗi khởi tạo Cloud Database (hệ thống tiếp tục chạy bằng SQLite cục bộ):', err.message);
    return { cloud: false, error: err.message };
  }
}

// Đồng bộ toàn bộ dữ liệu từ local lên Cloud
async function syncAllLocalToCloud(localDb, client = getCloudClient()) {
  if (!client) return;
  const tables = ['projects', 'suppliers', 'materials', 'vehicles', 'users', 'tickets'];

  for (const t of tables) {
    const rows = (localDb.originalPrepare || localDb.prepare.bind(localDb))(`SELECT * FROM ${t}`).all();
    if (rows.length === 0) continue;

    const queries = rows.map(r => {
      const keys = Object.keys(r);
      const cols = keys.join(', ');
      const qs = keys.map(() => '?').join(', ');
      return {
        sql: `INSERT OR REPLACE INTO ${t} (${cols}) VALUES (${qs})`,
        args: keys.map(k => r[k])
      };
    });

    // Chia theo lô 50 câu lệnh
    for (let i = 0; i < queries.length; i += 50) {
      const chunk = queries.slice(i, i + 50);
      await client.batch(chunk, 'write');
    }
  }
}

// Chạy một câu lệnh SQL lên Cloud trong background khi có INSERT / UPDATE / DELETE
function executeCloudSql(sql, params = []) {
  if (!isCloudConfigured()) return;
  const client = getCloudClient();
  if (!client) return;

  // Thực thi bất đồng bộ trên Cloud
  client.execute({ sql, args: params }).catch(err => {
    console.error('⚠️ Lỗi đồng bộ SQL lên Cloud Turso:', err.message, '| SQL:', sql.substring(0, 60));
  });
}

module.exports = {
  isCloudConfigured,
  getCloudClient,
  initCloudDatabase,
  syncAllLocalToCloud,
  executeCloudSql
};
