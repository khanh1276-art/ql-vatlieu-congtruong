// Máy chủ HTTP REST API & Phục vụ giao diện cho Phần mềm Quản lý Kho Vật Liệu Công Trường
// Hỗ trợ: Đa Dự Án, Đa Đơn Vị Tính, Phân Quyền Tài Khoản (Admin vs Công trường) & Khóa Số Liệu Qua Ngày
// Sử dụng node:http thuần & node:sqlite (Zero-Dependency)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

const { db, hashPassword, verifyPassword } = require('./db.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Tiện ích lấy thời gian hiện tại định dạng YYYY-MM-DD HH:mm:ss theo giờ địa phương
function getLocalDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getLocalDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Chuẩn hóa chuỗi thời gian (hỗ trợ ISO, DD/MM/YYYY, HH:mm hoặc Date object)
function normalizeDateTime(val, fallbackDate = getLocalDateString()) {
  if (!val) return `${fallbackDate} 08:00:00`;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return getLocalDateTime(val);
  }
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(str)) {
    const clean = str.replace('T', ' ');
    return clean.length === 16 ? `${clean}:00` : clean;
  }
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})([ T](\d{1,2}:\d{1,2}(:\d{1,2})?))?$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    let timePart = '08:00:00';
    if (dmyMatch[5]) {
      const parts = dmyMatch[5].split(':');
      const h = parts[0].padStart(2, '0');
      const m = parts[1].padStart(2, '0');
      const s = (parts[2] || '00').padStart(2, '0');
      timePart = `${h}:${m}:${s}`;
    }
    return `${year}-${month}-${day} ${timePart}`;
  }
  if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(str)) {
    const parts = str.split(':');
    const h = parts[0].padStart(2, '0');
    const m = parts[1].padStart(2, '0');
    const s = (parts[2] || '00').padStart(2, '0');
    return `${fallbackDate} ${h}:${m}:${s}`;
  }
  return `${fallbackDate} 08:00:00`;
}

// Sinh mã phiếu theo ngày: NK-YYYYMMDD-XXXX
function generateTicketCode(customDateOrString = null) {
  let d = new Date();
  if (customDateOrString) {
    if (typeof customDateOrString === 'string' && customDateOrString.length >= 10) {
      const cleanDate = customDateOrString.slice(0, 10).replace(/[^0-9]/g, '');
      if (cleanDate.length === 8) {
        const prefix = `NK-${cleanDate}-`;
        const lastTicket = db.prepare(`
          SELECT ticket_code FROM tickets 
          WHERE ticket_code LIKE ? 
          ORDER BY id DESC LIMIT 1
        `).get(`${prefix}%`);

        let nextSeq = 1;
        if (lastTicket && lastTicket.ticket_code) {
          const parts = lastTicket.ticket_code.split('-');
          const currentSeq = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(currentSeq)) {
            nextSeq = currentSeq + 1;
          }
        }
        return `${prefix}${String(nextSeq).padStart(4, '0')}`;
      }
    }
    const parsed = new Date(customDateOrString);
    if (!isNaN(parsed.getTime())) d = parsed;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const prefix = `NK-${dateStr}-`;

  const lastTicket = db.prepare(`
    SELECT ticket_code FROM tickets 
    WHERE ticket_code LIKE ? 
    ORDER BY id DESC LIMIT 1
  `).get(`${prefix}%`);

  let nextSeq = 1;
  if (lastTicket && lastTicket.ticket_code) {
    const parts = lastTicket.ticket_code.split('-');
    const currentSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(currentSeq)) {
      nextSeq = currentSeq + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

// Đọc body của request dạng JSON
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error('Payload too large (Tối đa 25MB)'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Phản hồi JSON
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token'
  });
  res.end(JSON.stringify(data));
}

// Trích xuất thông tin người dùng từ Token phiên làm việc
function getAuthenticatedUser(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-auth-token'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    token = authHeader.trim();
  }

  if (!token && req.url) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      token = parsedUrl.searchParams.get('token') || '';
    } catch (e) {}
  }

  if (!token) return null;

  try {
    const session = db.prepare(`
      SELECT s.*, u.id as user_id, u.username, u.full_name, u.role, u.project_id, u.status as user_status,
             p.name as project_name
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN projects p ON u.project_id = p.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now', 'localtime')
    `).get(token);

    if (!session || session.user_status !== 'ACTIVE') return null;

    return {
      id: session.user_id,
      username: session.username,
      full_name: session.full_name,
      role: session.role,
      project_id: session.project_id,
      project_name: session.project_name
    };
  } catch (err) {
    console.error('Lỗi xác thực token:', err);
    return null;
  }
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive'
};

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-auth-token'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // =========================================================================
    // 1. API XÁC THỰC (AUTHENTICATION: LOGIN / LOGOUT / ME)
    // =========================================================================
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await parseRequestBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '';

      if (!username || !password) {
        return sendJson(res, 400, { error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
      }

      const user = db.prepare(`
        SELECT u.*, p.name as project_name 
        FROM users u
        LEFT JOIN projects p ON u.project_id = p.id
        WHERE lower(u.username) = ?
      `).get(username);

      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: 'Tên đăng nhập hoặc mật khẩu không chính xác' });
      }

      if (user.status !== 'ACTIVE') {
        return sendJson(res, 403, { error: 'Tài khoản này đang bị khóa. Vui lòng liên hệ Admin!' });
      }

      // Tạo token phiên làm việc ngẫu nhiên 64 ký tự hex
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Có hiệu lực 30 ngày

      db.prepare(`
        INSERT INTO sessions (token, user_id, expires_at)
        VALUES (?, ?, ?)
      `).run(token, user.id, getLocalDateTime(expiresAt));

      return sendJson(res, 200, {
        token,
        user: {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          role: user.role,
          project_id: user.project_id,
          project_name: user.project_name
        }
      });
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn' });
      }
      return sendJson(res, 200, user);
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const authHeader = req.headers['authorization'] || req.headers['x-auth-token'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
      if (token) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
      return sendJson(res, 200, { success: true });
    }

    // =========================================================================
    // 2. API QUẢN LÝ TÀI KHOẢN NGƯỜI DÙNG (DÀNH RIÊNG CHO ADMIN)
    // =========================================================================
    if (pathname === '/api/users' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xem danh sách tài khoản' });
      }

      const users = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.role, u.project_id, u.status, u.created_at,
               p.name as project_name
        FROM users u
        LEFT JOIN projects p ON u.project_id = p.id
        ORDER BY u.role ASC, u.id ASC
      `).all();

      return sendJson(res, 200, users);
    }

    if (pathname === '/api/users' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền tạo tài khoản' });
      }

      const body = await parseRequestBody(req);
      const username = (body.username || '').trim().toLowerCase();
      const password = body.password || '123456';
      const fullName = (body.full_name || '').trim();
      let role = 'SITE_USER';
      if (body.role === 'ADMIN') role = 'ADMIN';
      else if (body.role === 'MODERATOR') role = 'MODERATOR';

      const projectId = role === 'SITE_USER' ? (parseInt(body.project_id, 10) || null) : null;

      if (!username || !fullName) {
        return sendJson(res, 400, { error: 'Tên đăng nhập và Họ tên không được để trống' });
      }

      if (role === 'SITE_USER' && !projectId) {
        return sendJson(res, 400, { error: 'Vui lòng chọn Dự án / Công trường gán cho tài khoản này' });
      }

      try {
        const result = db.prepare(`
          INSERT INTO users (username, password_hash, full_name, role, project_id, status)
          VALUES (?, ?, ?, ?, ?, 'ACTIVE')
        `).run(username, hashPassword(password), fullName, role, projectId);

        const newUser = db.prepare(`
          SELECT u.id, u.username, u.full_name, u.role, u.project_id, u.status, p.name as project_name
          FROM users u
          LEFT JOIN projects p ON u.project_id = p.id
          WHERE u.id = ?
        `).get(result.lastInsertRowid);

        return sendJson(res, 201, newUser);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return sendJson(res, 400, { error: `Tên đăng nhập "${username}" đã tồn tại` });
        }
        throw err;
      }
    }

    if (pathname.startsWith('/api/users/') && method === 'PUT') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền chỉnh sửa tài khoản' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!user) return sendJson(res, 404, { error: 'Không tìm thấy tài khoản' });

      let newPwdHash = user.password_hash;
      if (body.password && body.password.trim()) {
        newPwdHash = hashPassword(body.password.trim());
      }

      let role = user.role;
      if (body.role) {
        if (body.role === 'ADMIN') role = 'ADMIN';
        else if (body.role === 'MODERATOR') role = 'MODERATOR';
        else if (body.role === 'SITE_USER') role = 'SITE_USER';
      }
      const projectId = (role === 'ADMIN' || role === 'MODERATOR') ? null : (body.project_id ? parseInt(body.project_id, 10) : null);

      db.prepare(`
        UPDATE users SET
          full_name = COALESCE(?, full_name),
          role = ?,
          project_id = ?,
          password_hash = ?,
          status = COALESCE(?, status)
        WHERE id = ?
      `).run(
        body.full_name ? body.full_name.trim() : null,
        role,
        projectId,
        newPwdHash,
        body.status || null,
        id
      );

      const updated = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.role, u.project_id, u.status, p.name as project_name
        FROM users u
        LEFT JOIN projects p ON u.project_id = p.id
        WHERE u.id = ?
      `).get(id);

      return sendJson(res, 200, updated);
    }

    if (pathname.startsWith('/api/users/') && method === 'DELETE') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xóa tài khoản' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      if (id === currentUser.id) {
        return sendJson(res, 400, { error: 'Bạn không thể tự xóa tài khoản của chính mình' });
      }

      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 3. API DỰ ÁN (PROJECTS)
    // =========================================================================
    if (pathname === '/api/projects' && method === 'GET') {
      const list = db.prepare(`
        SELECT p.*,
          COUNT(DISTINCT CASE WHEN t.status != 'CANCELLED' THEN t.id END) as total_trips,
          COUNT(DISTINCT CASE WHEN t.status = 'IN_YARD' THEN t.id END) as in_yard_count,
          COUNT(DISTINCT t.supplier_id) as supplier_count
        FROM projects p
        LEFT JOIN tickets t ON t.project_id = p.id
        GROUP BY p.id
        ORDER BY p.name ASC
      `).all();
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/projects' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền thêm dự án' });
      }

      const body = await parseRequestBody(req);
      const name = (body.name || '').trim();
      const code = (body.code || '').trim().toUpperCase() || `DA-${Date.now().toString().slice(-4)}`;
      if (!name) return sendJson(res, 400, { error: 'Tên dự án không được để trống' });

      try {
        const result = db.prepare(`
          INSERT INTO projects (code, name, location, status, notes)
          VALUES (?, ?, ?, ?, ?)
        `).run(code, name, body.location || '', body.status || 'ACTIVE', body.notes || '');

        const newProj = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
        return sendJson(res, 201, newProj);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return sendJson(res, 400, { error: `Mã dự án ${code} đã tồn tại` });
        }
        throw err;
      }
    }

    if (pathname.startsWith('/api/projects/') && method === 'PUT') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ có Admin hoặc Điều Hành mới có quyền sửa dự án' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);
      db.prepare(`
        UPDATE projects SET 
          code = ?,
          name = ?,
          location = ?,
          status = ?,
          notes = ?
        WHERE id = ?
      `).run(
        (body.code || '').trim().toUpperCase(),
        (body.name || '').trim(),
        body.location || '',
        body.status || 'ACTIVE',
        body.notes || '',
        id
      );
      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      return sendJson(res, 200, updated);
    }

    if (pathname.startsWith('/api/projects/') && method === 'DELETE') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xóa dự án' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const isCascade = url.searchParams.get('cascade') === 'true';

      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      if (!project) {
        return sendJson(res, 404, { error: 'Không tìm thấy dự án' });
      }

      const usedTickets = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = ?').get(id).count;
      if (usedTickets > 0 && !isCascade) {
        return sendJson(res, 400, {
          error: `Dự án "${project.name}" đang có ${usedTickets} lượt xe. Vui lòng xác nhận xóa kèm toàn bộ dữ liệu xe hoặc xóa từng phiếu trước!`,
          hasTickets: true,
          ticketCount: usedTickets
        });
      }

      // Xóa tất cả phiếu của dự án nếu xóa cascade
      if (usedTickets > 0 && isCascade) {
        db.prepare('DELETE FROM tickets WHERE project_id = ?').run(id);
      }

      // Hủy liên kết xe và tài khoản khỏi dự án này
      db.prepare('UPDATE vehicles SET project_id = NULL WHERE project_id = ?').run(id);
      db.prepare('UPDATE users SET project_id = NULL WHERE project_id = ?').run(id);

      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id, name: project.name, deletedTickets: isCascade ? usedTickets : 0 });
    }

    // =========================================================================
    // 4. API DASHBOARD (Tự động lọc theo Role Công Trường hoặc query ProjectId)
    // =========================================================================
    if (pathname === '/api/dashboard' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      const todayStr = url.searchParams.get('date') || getLocalDateString();
      let projectId = url.searchParams.get('projectId');

      // Nếu tài khoản là SITE_USER, bắt buộc cố định theo project của mình
      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
      }

      let projectName = 'Tất cả 3 dự án';
      if (projectId) {
        const pObj = db.prepare('SELECT name FROM projects WHERE id = ?').get(parseInt(projectId, 10));
        if (pObj) projectName = pObj.name;
      }

      let projectFilter = '';
      const params = [todayStr];
      if (projectId) {
        projectFilter = ' AND project_id = ?';
        params.push(parseInt(projectId, 10));
      }

      const statsToday = db.prepare(`
        SELECT 
          COUNT(CASE WHEN status != 'CANCELLED' THEN 1 END) as total_trips,
          COUNT(CASE WHEN status = 'IN_YARD' THEN 1 END) as in_yard_count,
          COUNT(DISTINCT CASE WHEN status != 'CANCELLED' THEN supplier_id END) as active_suppliers
        FROM tickets
        WHERE date(time_in) = date(?) ${projectFilter}
      `).get(...params);

      const volumeByUnitToday = db.prepare(`
        SELECT 
          unit,
          ROUND(SUM(actual_volume), 2) as total_volume
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY unit
      `).all(...params);

      // Thêm sản lượng lũy kế toàn thời gian của dự án / hệ thống theo từng ĐVT
      let cumSql = "SELECT unit, ROUND(SUM(actual_volume), 2) as total_volume, COUNT(*) as trips FROM tickets WHERE status != 'CANCELLED'";
      const cumParams = [];
      if (projectId) {
        cumSql += ' AND project_id = ?';
        cumParams.push(parseInt(projectId, 10));
      }
      cumSql += ' GROUP BY unit';
      const cumulativeVolumeByUnit = db.prepare(cumSql).all(...cumParams);

      const materialBreakdown = db.prepare(`
        SELECT 
          material_name,
          unit,
          COUNT(*) as trips,
          ROUND(SUM(actual_volume), 2) as volume
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY material_name, unit
        ORDER BY volume DESC
      `).all(...params);

      const hourlyDistribution = db.prepare(`
        SELECT 
          strftime('%H', time_in) as hour,
          COUNT(*) as trips
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY hour
        ORDER BY hour ASC
      `).all(...params);

      let recentSql = 'SELECT * FROM tickets WHERE 1=1';
      const recentParams = [];
      if (projectId) {
        recentSql += ' AND project_id = ?';
        recentParams.push(parseInt(projectId, 10));
      }
      recentSql += ' ORDER BY id DESC LIMIT 10';
      const recentTickets = db.prepare(recentSql).all(...recentParams);

      return sendJson(res, 200, {
        today: todayStr,
        projectId: projectId ? parseInt(projectId, 10) : null,
        projectName,
        stats: statsToday,
        volumeByUnit: volumeByUnitToday,
        cumulativeVolumeByUnit,
        materialBreakdown,
        hourlyDistribution,
        recentTickets
      });
    }

    // =========================================================================
    // 5. API DANH MỤC XE & TRA CỨU
    // =========================================================================
    if (pathname === '/api/vehicles/lookup' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim();
      if (!query) return sendJson(res, 200, []);

      const vehicles = db.prepare(`
        SELECT v.*, s.name as supplier_name, m.name as default_material_name, m.unit as default_material_unit,
          p.name as project_name
        FROM vehicles v
        LEFT JOIN suppliers s ON v.supplier_id = s.id
        LEFT JOIN materials m ON v.default_material_id = m.id
        LEFT JOIN projects p ON v.project_id = p.id
        WHERE v.plate_number LIKE ?
        ORDER BY v.plate_number ASC
        LIMIT 10
      `).all(`%${query}%`);

      return sendJson(res, 200, vehicles);
    }

    if (pathname === '/api/vehicles' && method === 'GET') {
      const list = db.prepare(`
        SELECT v.*, s.name as supplier_name, m.name as default_material_name, m.unit as default_material_unit,
          p.name as project_name,
          (SELECT COUNT(*) FROM tickets t WHERE t.vehicle_id = v.id AND t.status != 'CANCELLED') as total_trips
        FROM vehicles v
        LEFT JOIN suppliers s ON v.supplier_id = s.id
        LEFT JOIN materials m ON v.default_material_id = m.id
        LEFT JOIN projects p ON v.project_id = p.id
        ORDER BY v.plate_number ASC
      `).all();
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/vehicles' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ Admin hoặc Điều Hành mới có quyền thêm xe vào danh mục' });
      }

      const body = await parseRequestBody(req);
      const plate = (body.plate_number || '').trim().toUpperCase();
      if (!plate) return sendJson(res, 400, { error: 'Biển số xe không được để trống' });

      const stdVol = parseFloat(body.standard_volume) || 0;
      if (stdVol <= 0) return sendJson(res, 400, { error: 'Khối lượng cố định quy chuẩn phải lớn hơn 0' });

      try {
        const result = db.prepare(`
          INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, default_material_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          plate,
          body.model_type || '',
          body.supplier_id ? parseInt(body.supplier_id, 10) : null,
          body.project_id ? parseInt(body.project_id, 10) : null,
          parseFloat(body.length) || 0,
          parseFloat(body.width) || 0,
          parseFloat(body.height) || 0,
          stdVol,
          body.unit || 'm³',
          body.default_material_id ? parseInt(body.default_material_id, 10) : null,
          body.notes || ''
        );

        const newVehicle = db.prepare(`
          SELECT v.*, s.name as supplier_name, m.name as default_material_name, p.name as project_name
          FROM vehicles v
          LEFT JOIN suppliers s ON v.supplier_id = s.id
          LEFT JOIN materials m ON v.default_material_id = m.id
          LEFT JOIN projects p ON v.project_id = p.id
          WHERE v.id = ?
        `).get(result.lastInsertRowid);

        return sendJson(res, 201, newVehicle);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return sendJson(res, 400, { error: `Biển số xe ${plate} đã tồn tại trong danh mục` });
        }
        throw err;
      }
    }

    if (pathname.startsWith('/api/vehicles/') && method === 'PUT') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ Admin hoặc Điều Hành mới có quyền sửa thông tin xe' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);
      const plate = (body.plate_number || '').trim().toUpperCase();
      const stdVol = parseFloat(body.standard_volume) || 0;

      db.prepare(`
        UPDATE vehicles SET 
          plate_number = ?,
          model_type = ?,
          supplier_id = ?,
          project_id = ?,
          length = ?,
          width = ?,
          height = ?,
          standard_volume = ?,
          unit = ?,
          default_material_id = ?,
          notes = ?
        WHERE id = ?
      `).run(
        plate,
        body.model_type || '',
        body.supplier_id ? parseInt(body.supplier_id, 10) : null,
        body.project_id ? parseInt(body.project_id, 10) : null,
        parseFloat(body.length) || 0,
        parseFloat(body.width) || 0,
        parseFloat(body.height) || 0,
        stdVol,
        body.unit || 'm³',
        body.default_material_id ? parseInt(body.default_material_id, 10) : null,
        body.notes || '',
        id
      );

      const updated = db.prepare(`
        SELECT v.*, s.name as supplier_name, m.name as default_material_name, p.name as project_name
        FROM vehicles v
        LEFT JOIN suppliers s ON v.supplier_id = s.id
        LEFT JOIN materials m ON v.default_material_id = m.id
        LEFT JOIN projects p ON v.project_id = p.id
        WHERE v.id = ?
      `).get(id);

      return sendJson(res, 200, updated);
    }

    if (pathname.startsWith('/api/vehicles/') && method === 'DELETE') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xóa xe trong danh mục' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 6. API NHÀ CUNG CẤP & VẬT LIỆU
    // =========================================================================
    if (pathname === '/api/suppliers' && method === 'GET') {
      const list = db.prepare(`
        SELECT s.*, 
          COUNT(DISTINCT v.id) as vehicle_count,
          COUNT(DISTINCT CASE WHEN t.status != 'CANCELLED' THEN t.id END) as total_trips
        FROM suppliers s
        LEFT JOIN vehicles v ON v.supplier_id = s.id
        LEFT JOIN tickets t ON t.supplier_id = s.id
        GROUP BY s.id
        ORDER BY s.name ASC
      `).all();
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/suppliers' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ Admin hoặc Điều Hành mới có quyền thêm nhà cung cấp' });
      }

      const body = await parseRequestBody(req);
      const name = (body.name || '').trim();
      const code = (body.code || '').trim().toUpperCase() || `NCC-${Date.now().toString().slice(-4)}`;
      if (!name) return sendJson(res, 400, { error: 'Tên nhà cung cấp không được để trống' });

      try {
        const result = db.prepare(`
          INSERT INTO suppliers (code, name, phone, contact_person, notes)
          VALUES (?, ?, ?, ?, ?)
        `).run(code, name, body.phone || '', body.contact_person || '', body.notes || '');

        const newSupplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
        return sendJson(res, 201, newSupplier);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return sendJson(res, 400, { error: `Mã nhà cung cấp ${code} đã tồn tại` });
        }
        throw err;
      }
    }

    if (pathname.startsWith('/api/suppliers/') && method === 'PUT') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ Admin hoặc Điều Hành mới có quyền sửa thông tin nhà cung cấp' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);
      db.prepare(`
        UPDATE suppliers SET 
          code = ?,
          name = ?,
          phone = ?,
          contact_person = ?,
          notes = ?
        WHERE id = ?
      `).run(
        (body.code || '').trim().toUpperCase(),
        (body.name || '').trim(),
        body.phone || '',
        body.contact_person || '',
        body.notes || '',
        id
      );
      const updated = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
      return sendJson(res, 200, updated);
    }

    if (pathname.startsWith('/api/suppliers/') && method === 'DELETE') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xóa nhà cung cấp' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    if (pathname === '/api/materials' && method === 'GET') {
      const list = db.prepare(`
        SELECT m.*,
          COUNT(DISTINCT CASE WHEN t.status != 'CANCELLED' THEN t.id END) as total_trips,
          ROUND(COALESCE(SUM(CASE WHEN t.status != 'CANCELLED' THEN t.actual_volume ELSE 0 END), 0), 2) as cumulative_volume
        FROM materials m
        LEFT JOIN tickets t ON t.material_id = m.id
        GROUP BY m.id
        ORDER BY m.name ASC
      `).all();
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/materials' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ Admin hoặc Điều Hành mới có quyền thêm loại vật liệu' });
      }

      const body = await parseRequestBody(req);
      const name = (body.name || '').trim();
      const code = (body.code || '').trim().toUpperCase() || `VL-${Date.now().toString().slice(-4)}`;
      const unit = (body.unit || 'm³').trim();
      if (!name) return sendJson(res, 400, { error: 'Tên vật liệu không được để trống' });

      try {
        const result = db.prepare(`
          INSERT INTO materials (code, name, unit, description)
          VALUES (?, ?, ?, ?)
        `).run(code, name, unit, body.description || '');

        const newMaterial = db.prepare('SELECT * FROM materials WHERE id = ?').get(result.lastInsertRowid);
        return sendJson(res, 201, newMaterial);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          return sendJson(res, 400, { error: `Mã vật liệu ${code} đã tồn tại` });
        }
        throw err;
      }
    }

    if (pathname.startsWith('/api/materials/') && method === 'PUT') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'MODERATOR')) {
        return sendJson(res, 403, { error: 'Chỉ Admin hoặc Điều Hành mới có quyền sửa loại vật liệu' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);
      db.prepare(`
        UPDATE materials SET 
          code = ?,
          name = ?,
          unit = ?,
          description = ?
        WHERE id = ?
      `).run(
        (body.code || '').trim().toUpperCase(),
        (body.name || '').trim(),
        (body.unit || 'm³').trim(),
        body.description || '',
        id
      );
      const updated = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
      return sendJson(res, 200, updated);
    }

    if (pathname.startsWith('/api/materials/') && method === 'DELETE') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xóa loại vật liệu' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM materials WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 7. API QUẢN LÝ PHIẾU VÀO/RA (CHECK-IN / CHECK-OUT / KHÓA SỐ LIỆU QUA NGÀY)
    // =========================================================================
    if (pathname === '/api/tickets' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      const status = url.searchParams.get('status');
      const date = url.searchParams.get('date');
      const supplierId = url.searchParams.get('supplierId');
      const materialId = url.searchParams.get('materialId');
      let projectId = url.searchParams.get('projectId');
      const search = (url.searchParams.get('search') || '').trim();

      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
      }

      let sql = 'SELECT * FROM tickets WHERE 1=1';
      const params = [];

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }
      if (date) {
        sql += ' AND date(time_in) = date(?)';
        params.push(date);
      }
      if (projectId) {
        sql += ' AND project_id = ?';
        params.push(parseInt(projectId, 10));
      }
      if (supplierId) {
        sql += ' AND supplier_id = ?';
        params.push(parseInt(supplierId, 10));
      }
      if (materialId) {
        sql += ' AND material_id = ?';
        params.push(parseInt(materialId, 10));
      }
      if (search) {
        sql += ' AND (plate_number LIKE ? OR ticket_code LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }

      sql += ' ORDER BY id DESC';

      const tickets = db.prepare(sql).all(...params);
      return sendJson(res, 200, tickets);
    }

    if (pathname === '/api/tickets/in-yard' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      let projectId = url.searchParams.get('projectId');
      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
      }

      let sql = `SELECT * FROM tickets WHERE status = 'IN_YARD'`;
      const params = [];
      if (projectId) {
        sql += ' AND project_id = ?';
        params.push(parseInt(projectId, 10));
      }
      sql += ' ORDER BY time_in ASC';
      const tickets = db.prepare(sql).all(...params);
      return sendJson(res, 200, tickets);
    }

    // Ghi nhận XE VÀO CỔNG (Check-in)
    if (pathname === '/api/tickets/checkin' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      const body = await parseRequestBody(req);
      const plate = (body.plate_number || '').trim().toUpperCase();
      if (!plate) return sendJson(res, 400, { error: 'Biển số xe không được để trống' });

      // Dự án: Nếu là tài khoản công trường, ép buộc lấy dự án của tài khoản
      let projectId = body.project_id ? parseInt(body.project_id, 10) : null;
      let projectName = (body.project_name || '').trim();

      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
        projectName = currentUser.project_name;
      } else if (projectId && !projectName) {
        const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
        if (proj) projectName = proj.name;
      }

      if (!projectName) {
        const defProj = db.prepare('SELECT id, name FROM projects ORDER BY id ASC LIMIT 1').get();
        if (defProj) {
          projectId = defProj.id;
          projectName = defProj.name;
        } else {
          projectName = 'Công trường';
        }
      }

      // Kiểm tra xe đang trong bãi chưa ra
      const existingInYard = db.prepare(`
        SELECT * FROM tickets 
        WHERE plate_number = ? AND status = 'IN_YARD'
      `).get(plate);

      if (existingInYard) {
        return sendJson(res, 400, {
          error: `Xe ${plate} hiện vẫn đang có lượt vào lúc ${existingInYard.time_in} tại ${existingInYard.project_name || 'công trường'} chưa xác nhận ra cổng!`
        });
      }

      let supplierId = body.supplier_id ? parseInt(body.supplier_id, 10) : null;
      let supplierName = (body.supplier_name || '').trim();
      if (supplierId) {
        const supp = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplierId);
        if (supp) supplierName = supp.name;
      }

      let materialId = body.material_id ? parseInt(body.material_id, 10) : null;
      let materialName = (body.material_name || '').trim();
      let unit = (body.unit || '').trim();

      if (materialId) {
        const mat = db.prepare('SELECT name, unit FROM materials WHERE id = ?').get(materialId);
        if (mat) {
          materialName = mat.name;
          if (!unit) unit = mat.unit || 'm³';
        }
      }
      if (!unit) unit = 'm³';

      if (!materialName) return sendJson(res, 400, { error: 'Vui lòng chọn loại vật liệu chuyên chở' });
      if (!supplierName) return sendJson(res, 400, { error: 'Vui lòng chọn nhà cung cấp' });

      const length = parseFloat(body.length) || 0;
      const width = parseFloat(body.width) || 0;
      const height = parseFloat(body.height) || 0;
      const standardVolume = parseFloat(body.standard_volume) || 0;

      const isManualAdjusted = body.is_manual_adjusted ? 1 : 0;
      let actualVolume = standardVolume;
      if (isManualAdjusted && body.actual_volume !== undefined && body.actual_volume !== null && body.actual_volume !== '') {
        actualVolume = parseFloat(body.actual_volume) || 0;
      }

      if (actualVolume <= 0) {
        return sendJson(res, 400, { error: `Khối lượng nghiệm thu phải lớn hơn 0 ${unit}` });
      }

      let vehicleId = body.vehicle_id ? parseInt(body.vehicle_id, 10) : null;
      let vehRecord = db.prepare('SELECT id FROM vehicles WHERE plate_number = ?').get(plate);
      if (vehRecord) {
        vehicleId = vehRecord.id;
      } else {
        const vInsert = db.prepare(`
          INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, default_material_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          plate,
          body.model_type || 'Xe vận chuyển',
          supplierId,
          projectId,
          length, width, height,
          standardVolume,
          unit,
          materialId,
          'Tự động thêm khi vào cổng lần đầu'
        );
        vehicleId = vInsert.lastInsertRowid;
      }

      const ticketCode = generateTicketCode();
      const timeIn = body.time_in ? body.time_in : getLocalDateTime();
      const createdBy = currentUser ? `${currentUser.full_name} (${currentUser.role === 'ADMIN' ? 'Admin' : 'Công trường'})` : 'Cán bộ trực cổng';

      const result = db.prepare(`
        INSERT INTO tickets (
          ticket_code, project_id, project_name, vehicle_id, plate_number, supplier_id, supplier_name,
          material_id, material_name, unit, time_in, time_out,
          length, width, height, standard_volume, actual_volume,
          is_manual_adjusted, adjustment_reason, status, created_by, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'IN_YARD', ?, ?, ?)
      `).run(
        ticketCode, projectId, projectName, vehicleId, plate, supplierId, supplierName,
        materialId, materialName, unit, timeIn,
        length, width, height, standardVolume, actualVolume,
        isManualAdjusted, body.adjustment_reason || '',
        createdBy,
        body.notes || '',
        timeIn
      );

      const createdTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid);
      return sendJson(res, 201, createdTicket);
    }

    // Xác nhận XE RA CỔNG (Check-out)
    if (pathname.match(/^\/api\/tickets\/\d+\/checkout$/) && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);

      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) return sendJson(res, 404, { error: 'Không tìm thấy phiếu xe vào' });
      if (ticket.status === 'COMPLETED') {
        return sendJson(res, 400, { error: 'Phiếu này đã xác nhận ra cổng trước đó' });
      }

      // Kiểm tra quyền: nếu là SITE_USER, không được thao tác trên xe của dự án khác
      if (currentUser && currentUser.role === 'SITE_USER' && ticket.project_id !== currentUser.project_id) {
        return sendJson(res, 403, { error: 'Bạn không có quyền thao tác trên xe của dự án khác!' });
      }

      const timeOut = body.time_out ? body.time_out : getLocalDateTime();

      let actualVolume = ticket.actual_volume;
      let isManualAdjusted = ticket.is_manual_adjusted;
      let adjustmentReason = ticket.adjustment_reason;

      if (body.actual_volume !== undefined && body.actual_volume !== null && body.actual_volume !== '') {
        actualVolume = parseFloat(body.actual_volume);
        isManualAdjusted = 1;
        if (body.adjustment_reason) {
          adjustmentReason = body.adjustment_reason;
        }
      }

      db.prepare(`
        UPDATE tickets SET
          status = 'COMPLETED',
          time_out = ?,
          actual_volume = ?,
          is_manual_adjusted = ?,
          adjustment_reason = ?,
          notes = CASE WHEN ? != '' THEN notes || ' | ' || ? ELSE notes END
        WHERE id = ?
      `).run(
        timeOut,
        actualVolume,
        isManualAdjusted,
        adjustmentReason,
        body.notes || '',
        body.notes || '',
        id
      );

      const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      return sendJson(res, 200, updated);
    }

    // Cập nhật thông tin phiếu (Sửa lại khi nhập nhầm thông tin)
    // QUY TẮC KHÓA SỐ LIỆU QUA NGÀY (TIME-LOCK)
    if (pathname.match(/^\/api\/tickets\/\d+$/) && method === 'PUT') {
      const currentUser = getAuthenticatedUser(req);
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);

      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) return sendJson(res, 404, { error: 'Không tìm thấy phiếu' });

      // KIỂM TRA QUY TẮC KHÓA SỐ LIỆU QUA 24H CHO TÀI KHOẢN CÔNG TRƯỜNG (SITE_USER)
      if (currentUser && currentUser.role === 'SITE_USER') {
        if (ticket.project_id !== currentUser.project_id) {
          return sendJson(res, 403, { error: 'Bạn không có quyền điều chỉnh số liệu của dự án khác!' });
        }

        let hoursElapsed = 0;
        try {
          const tTime = new Date(ticket.time_in.replace(' ', 'T')).getTime();
          hoursElapsed = (Date.now() - tTime) / (1000 * 60 * 60);
        } catch (e) {
          hoursElapsed = 999;
        }

        if (hoursElapsed > 24) {
          return sendJson(res, 403, {
            error: `🔒 Phiếu xe này đã quá thời hạn 24 giờ (${Math.round(hoursElapsed)}h) và đã bị khóa sổ. Chỉ Admin hoặc Quản lý / Điều Hành mới có quyền điều chỉnh!`
          });
        }
      }
      // ADMIN và MODERATOR có toàn quyền sửa mọi phiếu ở mọi dự án và mọi ngày!

      db.prepare(`
        UPDATE tickets SET
          project_id = COALESCE(?, project_id),
          project_name = COALESCE(?, project_name),
          plate_number = COALESCE(?, plate_number),
          supplier_name = COALESCE(?, supplier_name),
          material_name = COALESCE(?, material_name),
          unit = COALESCE(?, unit),
          length = COALESCE(?, length),
          width = COALESCE(?, width),
          height = COALESCE(?, height),
          standard_volume = COALESCE(?, standard_volume),
          actual_volume = COALESCE(?, actual_volume),
          is_manual_adjusted = COALESCE(?, is_manual_adjusted),
          adjustment_reason = COALESCE(?, adjustment_reason),
          notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(
        body.project_id ? parseInt(body.project_id, 10) : null,
        body.project_name || null,
        body.plate_number ? body.plate_number.toUpperCase() : null,
        body.supplier_name || null,
        body.material_name || null,
        body.unit || null,
        body.length !== undefined ? parseFloat(body.length) : null,
        body.width !== undefined ? parseFloat(body.width) : null,
        body.height !== undefined ? parseFloat(body.height) : null,
        body.standard_volume !== undefined ? parseFloat(body.standard_volume) : null,
        body.actual_volume !== undefined ? parseFloat(body.actual_volume) : null,
        body.is_manual_adjusted !== undefined ? (body.is_manual_adjusted ? 1 : 0) : null,
        body.adjustment_reason || null,
        body.notes || null,
        id
      );

      const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      return sendJson(res, 200, updated);
    }

    // Xóa vĩnh viễn phiếu xe (CHỈ DÀNH RIÊNG CHO ADMIN ĐỂ DỌN DẸP DỮ LIỆU)
    if (pathname.match(/^\/api\/tickets\/\d+$/) && method === 'DELETE') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ có Admin văn phòng mới có quyền xóa dữ liệu phiếu xe' });
      }

      const id = parseInt(pathname.split('/')[3], 10);
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) return sendJson(res, 404, { error: 'Không tìm thấy phiếu xe cần xóa' });

      db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id, ticket_code: ticket.ticket_code });
    }

    // 7.8 API NHẬP LIỆU BỔ SUNG THEO LÔ TỪ FILE EXCEL BÁO CÁO NGÀY
    if (pathname === '/api/tickets/import-batch' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      const body = await parseRequestBody(req);

      const items = Array.isArray(body.tickets) ? body.tickets : [];
      if (items.length === 0) {
        return sendJson(res, 400, { error: 'Danh sách dữ liệu nhập rỗng hoặc không đúng định dạng.' });
      }

      // Kiểm tra quyền đối với tài khoản công trường
      if (currentUser && currentUser.role === 'SITE_USER') {
        if (body.project_id && parseInt(body.project_id, 10) !== currentUser.project_id) {
          return sendJson(res, 403, { error: 'Bạn chỉ có quyền nhập dữ liệu cho công trường được phân công!' });
        }
      }

      const duplicateMode = body.duplicate_mode || 'update'; // 'update' | 'skip' | 'generate_new'
      const fallbackDate = body.default_date || getLocalDateString();
      const overrideProjectId = body.project_id ? parseInt(body.project_id, 10) : null;

      let insertedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      // Chuẩn bị statement tái sử dụng
      const stmtFindProjectById = db.prepare('SELECT id, name FROM projects WHERE id = ?');
      const stmtFindProjectByName = db.prepare('SELECT id, name FROM projects WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) OR LOWER(TRIM(code)) = LOWER(TRIM(?))');
      const stmtFindProjectLike = db.prepare('SELECT id, name FROM projects WHERE LOWER(TRIM(name)) LIKE ? OR LOWER(TRIM(code)) LIKE ?');
      const stmtInsertProject = db.prepare('INSERT INTO projects (code, name, notes) VALUES (?, ?, ?)');
      const stmtGetDefaultProject = db.prepare('SELECT id, name FROM projects ORDER BY id ASC LIMIT 1');

      const stmtFindSupplierByName = db.prepare('SELECT id, name FROM suppliers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) OR LOWER(TRIM(code)) = LOWER(TRIM(?))');
      const stmtFindSupplierLike = db.prepare('SELECT id, name FROM suppliers WHERE LOWER(TRIM(name)) LIKE ?');
      const stmtInsertSupplier = db.prepare('INSERT INTO suppliers (code, name, notes) VALUES (?, ?, ?)');

      const stmtFindMaterialByName = db.prepare('SELECT id, name, unit FROM materials WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) OR LOWER(TRIM(code)) = LOWER(TRIM(?))');
      const stmtFindMaterialLike = db.prepare('SELECT id, name, unit FROM materials WHERE LOWER(TRIM(name)) LIKE ?');
      const stmtInsertMaterial = db.prepare('INSERT INTO materials (code, name, unit) VALUES (?, ?, ?)');

      const stmtFindVehicle = db.prepare('SELECT id, length, width, height, standard_volume, unit FROM vehicles WHERE plate_number = ?');
      const stmtInsertVehicle = db.prepare(`
        INSERT INTO vehicles (plate_number, model_type, supplier_id, project_id, length, width, height, standard_volume, unit, default_material_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const stmtFindTicketByCode = db.prepare('SELECT * FROM tickets WHERE ticket_code = ?');
      const stmtInsertTicket = db.prepare(`
        INSERT INTO tickets (
          ticket_code, project_id, project_name, vehicle_id, plate_number, supplier_id, supplier_name,
          material_id, material_name, unit, time_in, time_out,
          length, width, height, standard_volume, actual_volume,
          is_manual_adjusted, adjustment_reason, status, created_by, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const stmtUpdateTicket = db.prepare(`
        UPDATE tickets SET
          project_id = ?, project_name = ?, vehicle_id = ?, plate_number = ?,
          supplier_id = ?, supplier_name = ?, material_id = ?, material_name = ?, unit = ?,
          time_in = ?, time_out = ?,
          length = ?, width = ?, height = ?, standard_volume = ?, actual_volume = ?,
          is_manual_adjusted = ?, adjustment_reason = ?, status = ?, notes = ?
        WHERE id = ?
      `);

      // Khởi tạo Transaction an toàn
      db.exec('BEGIN TRANSACTION');
      try {
        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const plate = String(item.plate_number || '').trim().toUpperCase();
          if (!plate) {
            skippedCount++;
            continue;
          }

          // 1. Xác định Dự Án
          let pId = overrideProjectId;
          let pName = '';

          if (currentUser && currentUser.role === 'SITE_USER') {
            pId = currentUser.project_id;
            pName = currentUser.project_name;
          } else if (pId) {
            const p = stmtFindProjectById.get(pId);
            if (p) pName = p.name;
          } else if (item.project_name && String(item.project_name).trim()) {
            const rawPName = String(item.project_name).trim();
            let p = stmtFindProjectByName.get(rawPName, rawPName);
            if (!p) {
              p = stmtFindProjectLike.get(`%${rawPName}%`, `%${rawPName}%`);
            }
            if (p) {
              pId = p.id;
              pName = p.name;
            } else {
              const pCode = 'DA-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 100);
              const resP = stmtInsertProject.run(pCode, rawPName, 'Tự động tạo khi nhập bổ sung Excel');
              pId = resP.lastInsertRowid;
              pName = rawPName;
            }
          }

          if (!pId) {
            const defP = stmtGetDefaultProject.get();
            if (defP) {
              pId = defP.id;
              pName = defP.name;
            } else {
              pName = 'Công trường';
            }
          }

          // 2. Xác định Nhà Cung Cấp
          let sId = null;
          let sName = String(item.supplier_name || '').trim();
          if (sName) {
            let s = stmtFindSupplierByName.get(sName, sName);
            if (!s) {
              s = stmtFindSupplierLike.get(`%${sName}%`);
            }
            if (s) {
              sId = s.id;
              sName = s.name;
            } else {
              const sCode = 'NCC-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 100);
              const resS = stmtInsertSupplier.run(sCode, sName, 'Tự động tạo khi nhập bổ sung Excel');
              sId = resS.lastInsertRowid;
            }
          } else {
            sName = 'Chưa xác định';
          }

          // 3. Xác định Loại Vật Liệu & ĐVT
          let mId = null;
          let mName = String(item.material_name || '').trim();
          let unit = String(item.unit || '').trim() || 'm³';

          if (mName) {
            let m = stmtFindMaterialByName.get(mName, mName);
            if (!m) {
              m = stmtFindMaterialLike.get(`%${mName}%`);
            }
            if (m) {
              mId = m.id;
              mName = m.name;
              if (!unit && m.unit) unit = m.unit;
            } else {
              const mCode = 'VL-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 100);
              const resM = stmtInsertMaterial.run(mCode, mName, unit);
              mId = resM.lastInsertRowid;
            }
          } else {
            mName = 'Vật liệu chưa định danh';
          }

          // 4. Phân tích Kích thước (Dimensions)
          let length = 0, width = 0, height = 0;
          if (item.dimensions && typeof item.dimensions === 'string') {
            const parts = item.dimensions.split(/[xX*]/).map(p => parseFloat(p.trim()));
            if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
              length = parts[0];
              width = parts[1];
              height = parts[2];
            }
          }
          if (item.length) length = parseFloat(item.length) || length;
          if (item.width) width = parseFloat(item.width) || width;
          if (item.height) height = parseFloat(item.height) || height;

          // 5. Khối lượng
          let standardVolume = parseFloat(item.standard_volume) || 0;
          let actualVolume = parseFloat(item.actual_volume) || 0;
          if (actualVolume <= 0 && standardVolume > 0) actualVolume = standardVolume;
          if (standardVolume <= 0 && actualVolume > 0) standardVolume = actualVolume;

          // 6. Xe vận chuyển
          let vId = null;
          let veh = stmtFindVehicle.get(plate);
          if (veh) {
            vId = veh.id;
          } else {
            const resV = stmtInsertVehicle.run(
              plate,
              'Xe vận chuyển',
              sId,
              pId,
              length, width, height,
              standardVolume,
              unit,
              mId,
              'Tự động thêm khi nhập bổ sung Excel'
            );
            vId = resV.lastInsertRowid;
          }

          // 7. Thời gian Vào / Ra
          let timeIn = normalizeDateTime(item.time_in, fallbackDate);
          let timeOut = null;
          if (item.time_out && String(item.time_out).trim() && !String(item.time_out).includes('Đang trong bãi') && !String(item.time_out).includes('Chưa ra')) {
            timeOut = normalizeDateTime(item.time_out, fallbackDate);
          }

          const status = timeOut ? 'COMPLETED' : 'IN_YARD';

          // 8. Điều chỉnh
          let isManualAdjusted = 0;
          let adjustReason = String(item.adjustment_reason || '').trim();
          if (adjustReason && !adjustReason.toLowerCase().includes('đúng quy chuẩn') && !adjustReason.toLowerCase().includes('dung quy chuan')) {
            isManualAdjusted = 1;
          } else if (Math.abs(actualVolume - standardVolume) > 0.001) {
            isManualAdjusted = 1;
            if (!adjustReason) adjustReason = 'Điều chỉnh theo nghiệm thu thực tế';
          }

          // 9. Ghi chú
          let notes = String(item.notes || '').trim();
          if (!notes.includes('[Nhập bổ sung]')) {
            notes = notes ? `${notes} [Nhập bổ sung]` : '[Nhập bổ sung]';
          }

          const createdBy = currentUser
            ? `${currentUser.full_name} (${currentUser.role === 'ADMIN' ? 'Admin' : 'Công trường'} - Nhập Excel)`
            : 'Hệ thống (Nhập bổ sung Excel)';

          // 10. Xử lý Mã Phiếu & Trùng mã
          let ticketCode = String(item.ticket_code || '').trim();
          let existingTicket = null;
          if (ticketCode) {
            existingTicket = stmtFindTicketByCode.get(ticketCode);
          }

          if (existingTicket) {
            if (duplicateMode === 'skip') {
              skippedCount++;
              continue;
            } else if (duplicateMode === 'generate_new') {
              ticketCode = generateTicketCode(timeIn);
              stmtInsertTicket.run(
                ticketCode, pId, pName, vId, plate, sId, sName,
                mId, mName, unit, timeIn, timeOut,
                length, width, height, standardVolume, actualVolume,
                isManualAdjusted, adjustReason, status, createdBy, notes, timeIn
              );
              insertedCount++;
            } else {
              // 'update'
              stmtUpdateTicket.run(
                pId, pName, vId, plate,
                sId, sName, mId, mName, unit,
                timeIn, timeOut,
                length, width, height, standardVolume, actualVolume,
                isManualAdjusted, adjustReason, status, notes,
                existingTicket.id
              );
              updatedCount++;
            }
          } else {
            if (!ticketCode) {
              ticketCode = generateTicketCode(timeIn);
            }
            stmtInsertTicket.run(
              ticketCode, pId, pName, vId, plate, sId, sName,
              mId, mName, unit, timeIn, timeOut,
              length, width, height, standardVolume, actualVolume,
              isManualAdjusted, adjustReason, status, createdBy, notes, timeIn
            );
            insertedCount++;
          }
        }

        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        console.error('[IMPORT-BATCH] Lỗi transaction:', err);
        return sendJson(res, 500, { error: 'Không thể nhập dữ liệu: ' + err.message });
      }

      return sendJson(res, 200, {
        success: true,
        message: `Xử lý thành công: ${insertedCount} thêm mới, ${updatedCount} cập nhật, ${skippedCount} bỏ qua.`,
        inserted: insertedCount,
        updated: updatedCount,
        skipped: skippedCount,
        total: items.length
      });
    }

    // =========================================================================
    // 8. BÁO CÁO HÀNG NGÀY & LŨY KẾ
    // =========================================================================
    if (pathname === '/api/reports/daily' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      const date = url.searchParams.get('date') || getLocalDateString();
      let projectId = url.searchParams.get('projectId');
      const supplierId = url.searchParams.get('supplierId');

      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
      }

      let extraFilter = '';
      const params = [date];
      if (projectId) {
        extraFilter += ' AND project_id = ?';
        params.push(parseInt(projectId, 10));
      }
      if (supplierId) {
        extraFilter += ' AND supplier_id = ?';
        params.push(parseInt(supplierId, 10));
      }

      const tickets = db.prepare(`
        SELECT * FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${extraFilter}
        ORDER BY time_in ASC
      `).all(...params);

      const summary = db.prepare(`
        SELECT 
          COUNT(*) as total_trips,
          COUNT(DISTINCT supplier_name) as total_suppliers,
          COUNT(DISTINCT plate_number) as total_vehicles,
          COUNT(DISTINCT project_name) as total_projects
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${extraFilter}
      `).get(...params);

      const byMaterial = db.prepare(`
        SELECT 
          material_name,
          unit,
          COUNT(*) as trips,
          ROUND(SUM(actual_volume), 2) as volume
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${extraFilter}
        GROUP BY material_name, unit
        ORDER BY trips DESC
      `).all(...params);

      const bySupplier = db.prepare(`
        SELECT 
          supplier_name,
          COUNT(*) as trips
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${extraFilter}
        GROUP BY supplier_name
        ORDER BY trips DESC
      `).all(...params);

      const byProject = db.prepare(`
        SELECT 
          project_id,
          project_name,
          COUNT(*) as trips
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${extraFilter}
        GROUP BY project_name
        ORDER BY trips DESC
      `).all(...params);

      for (const p of byProject) {
        let pFilter = `WHERE date(time_in) = date(?) AND status != 'CANCELLED' AND project_name = ?`;
        const pParams = [date, p.project_name];
        if (supplierId) {
          pFilter += ` AND supplier_id = ?`;
          pParams.push(parseInt(supplierId, 10));
        }
        p.volume_by_unit = db.prepare(`
          SELECT unit, ROUND(SUM(actual_volume), 2) as volume
          FROM tickets
          ${pFilter}
          GROUP BY unit
          ORDER BY volume DESC
        `).all(...pParams);
      }

      return sendJson(res, 200, {
        date,
        summary,
        byMaterial,
        bySupplier,
        byProject,
        tickets
      });
    }

    if (pathname === '/api/reports/cumulative' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      const startDate = url.searchParams.get('startDate') || getLocalDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
      const endDate = url.searchParams.get('endDate') || getLocalDateString();
      let projectId = url.searchParams.get('projectId');
      const supplierId = url.searchParams.get('supplierId');
      const materialId = url.searchParams.get('materialId');

      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
      }

      let filterSql = ` AND date(time_in) >= date(?) AND date(time_in) <= date(?) AND status != 'CANCELLED'`;
      const baseParams = [startDate, endDate];

      if (projectId) {
        filterSql += ' AND project_id = ?';
        baseParams.push(parseInt(projectId, 10));
      }
      if (supplierId) {
        filterSql += ' AND supplier_id = ?';
        baseParams.push(parseInt(supplierId, 10));
      }
      if (materialId) {
        filterSql += ' AND material_id = ?';
        baseParams.push(parseInt(materialId, 10));
      }

      const totalSummary = db.prepare(`
        SELECT 
          COUNT(*) as cumulative_trips,
          COUNT(DISTINCT supplier_name) as supplier_count,
          COUNT(DISTINCT plate_number) as vehicle_count,
          COUNT(DISTINCT project_name) as project_count,
          COUNT(DISTINCT date(time_in)) as active_days
        FROM tickets
        WHERE 1=1 ${filterSql}
      `).get(...baseParams);

      const byMaterial = db.prepare(`
        SELECT 
          material_id,
          material_name,
          unit,
          COUNT(*) as trips,
          ROUND(SUM(actual_volume), 2) as volume,
          COUNT(DISTINCT plate_number) as vehicle_count
        FROM tickets
        WHERE 1=1 ${filterSql}
        GROUP BY material_name, unit
        ORDER BY trips DESC
      `).all(...baseParams);

      const byProject = db.prepare(`
        SELECT 
          project_id,
          project_name,
          COUNT(*) as trips,
          COUNT(DISTINCT supplier_name) as supplier_count,
          COUNT(DISTINCT plate_number) as vehicle_count
        FROM tickets
        WHERE 1=1 ${filterSql}
        GROUP BY project_name
        ORDER BY trips DESC
      `).all(...baseParams);

      for (const p of byProject) {
        let pFilter = filterSql + ' AND project_name = ?';
        p.volume_by_unit = db.prepare(`
          SELECT unit, ROUND(SUM(actual_volume), 2) as volume
          FROM tickets
          WHERE 1=1 ${pFilter}
          GROUP BY unit
          ORDER BY volume DESC
        `).all(...baseParams, p.project_name);
      }

      const bySupplier = db.prepare(`
        SELECT 
          supplier_id,
          supplier_name,
          COUNT(*) as trips,
          COUNT(DISTINCT plate_number) as vehicle_count
        FROM tickets
        WHERE 1=1 ${filterSql}
        GROUP BY supplier_name
        ORDER BY trips DESC
      `).all(...baseParams);

      const supplierMaterialBreakdown = db.prepare(`
        SELECT 
          supplier_name,
          material_name,
          unit,
          COUNT(*) as trips,
          ROUND(SUM(actual_volume), 2) as volume
        FROM tickets
        WHERE 1=1 ${filterSql}
        GROUP BY supplier_name, material_name, unit
        ORDER BY supplier_name ASC, volume DESC
      `).all(...baseParams);

      const byVehicle = db.prepare(`
        SELECT 
          plate_number,
          supplier_name,
          project_name,
          material_name,
          unit,
          COUNT(*) as trips,
          ROUND(SUM(actual_volume), 2) as volume,
          ROUND(AVG(actual_volume), 2) as avg_volume,
          standard_volume
        FROM tickets
        WHERE 1=1 ${filterSql}
        GROUP BY plate_number, material_name, unit
        ORDER BY trips DESC
      `).all(...baseParams);

      return sendJson(res, 200, {
        startDate,
        endDate,
        summary: totalSummary,
        byMaterial,
        byProject,
        bySupplier,
        supplierMaterialBreakdown,
        byVehicle
      });
    }

    if (pathname === '/api/reports/export-excel' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      const type = url.searchParams.get('type') || 'daily';
      const date = url.searchParams.get('date') || getLocalDateString();
      const startDate = url.searchParams.get('startDate') || date;
      const endDate = url.searchParams.get('endDate') || date;
      let projectId = url.searchParams.get('projectId');
      const supplierId = url.searchParams.get('supplierId');

      if (currentUser && currentUser.role === 'SITE_USER') {
        projectId = currentUser.project_id;
      }

      let filename = `Bao_Cao_${type === 'daily' ? `Ngay_${date}` : `Luy_Ke_${startDate}_den_${endDate}`}.xls`;
      let xmlContent = '';

      if (type === 'daily') {
        let filterSql = `date(time_in) = date(?) AND status != 'CANCELLED'`;
        const params = [date];
        if (projectId) {
          filterSql += ` AND project_id = ?`;
          params.push(parseInt(projectId, 10));
        }
        if (supplierId) {
          filterSql += ` AND supplier_id = ?`;
          params.push(parseInt(supplierId, 10));
        }

        const tickets = db.prepare(`SELECT * FROM tickets WHERE ${filterSql} ORDER BY time_in ASC`).all(...params);
        const summary = db.prepare(`SELECT COUNT(*) as trips FROM tickets WHERE ${filterSql}`).get(...params);

        xmlContent = buildDailyExcelXml(date, summary, tickets);
      } else {
        let filterSql = `date(time_in) >= date(?) AND date(time_in) <= date(?) AND status != 'CANCELLED'`;
        const params = [startDate, endDate];
        if (projectId) {
          filterSql += ` AND project_id = ?`;
          params.push(parseInt(projectId, 10));
        }
        if (supplierId) {
          filterSql += ` AND supplier_id = ?`;
          params.push(parseInt(supplierId, 10));
        }

        const cumulativeData = db.prepare(`
          SELECT 
            project_name,
            supplier_name,
            material_name,
            unit,
            plate_number,
            COUNT(*) as trips,
            ROUND(SUM(actual_volume), 2) as volume
          FROM tickets
          WHERE ${filterSql}
          GROUP BY project_name, supplier_name, material_name, unit, plate_number
          ORDER BY project_name ASC, supplier_name ASC, volume DESC
        `).all(...params);

        const summary = db.prepare(`SELECT COUNT(*) as trips FROM tickets WHERE ${filterSql}`).get(...params);

        xmlContent = buildCumulativeExcelXml(startDate, endDate, summary, cumulativeData);
      }

      res.writeHead(200, {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      return res.end(xmlContent);
    }

    // TẢI FILE EXCEL MẪU ĐỂ NHẬP LIỆU BỔ SUNG (THEO FORM BÁO CÁO NGÀY)
    if (pathname === '/api/reports/download-import-template' && method === 'GET') {
      const xmlContent = buildDailyExcelTemplateXml();
      res.writeHead(200, {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Mau_Nhap_Lieu_Bo_Sung_Vat_Lieu.xls"'
      });
      return res.end(xmlContent);
    }

    // =========================================================================
    // 8.1 API SAO LƯU & KHÔI PHỤC DỮ LIỆU (BACKUP & RESTORE - ADMIN ONLY)
    // =========================================================================
    if (pathname === '/api/backup/info' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ Admin mới có quyền xem thông tin sao lưu' });
      }

      const dbPath = path.join(__dirname, '..', 'data', 'inventory.db');
      let dbSize = 0;
      let lastModified = null;
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        dbSize = stats.size;
        lastModified = getLocalDateTime(stats.mtime);
      }

      const totalProjects = db.prepare('SELECT COUNT(*) as count FROM projects').get()?.count || 0;
      const totalVehicles = db.prepare('SELECT COUNT(*) as count FROM vehicles').get()?.count || 0;
      const totalMaterials = db.prepare('SELECT COUNT(*) as count FROM materials').get()?.count || 0;
      const totalSuppliers = db.prepare('SELECT COUNT(*) as count FROM suppliers').get()?.count || 0;
      const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get()?.count || 0;
      const totalTickets = db.prepare('SELECT COUNT(*) as count FROM tickets').get()?.count || 0;

      const isRender = process.env.RENDER === 'true';

      return sendJson(res, 200, {
        db_size_bytes: dbSize,
        db_size_kb: (dbSize / 1024).toFixed(1),
        last_modified: lastModified,
        is_render: isRender,
        cloud_connected: false,
        counts: {
          projects: totalProjects,
          vehicles: totalVehicles,
          materials: totalMaterials,
          suppliers: totalSuppliers,
          users: totalUsers,
          tickets: totalTickets
        }
      });
    }

    if (pathname === '/api/backup/export' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ Admin mới có quyền xuất bản sao lưu' });
      }

      const projects = db.prepare('SELECT * FROM projects').all();
      const suppliers = db.prepare('SELECT * FROM suppliers').all();
      const materials = db.prepare('SELECT * FROM materials').all();
      const vehicles = db.prepare('SELECT * FROM vehicles').all();
      const users = db.prepare('SELECT id, username, password_hash, full_name, role, project_id, status, created_at FROM users').all();
      const tickets = db.prepare('SELECT * FROM tickets').all();

      const backupData = {
        app: 'QuanLyVatLieuCongTruong',
        version: '2.0',
        exported_at: getLocalDateTime(),
        data: {
          projects,
          suppliers,
          materials,
          vehicles,
          users,
          tickets
        }
      };

      const dateStr = getLocalDateString().replace(/-/g, '');
      const filename = `Backup_VLXD_${dateStr}_${Date.now().toString().slice(-4)}.json`;

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      return res.end(JSON.stringify(backupData, null, 2));
    }

    if (pathname === '/api/backup/download-db' && method === 'GET') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ Admin mới có quyền tải file database' });
      }

      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (e) {
        console.error('Lỗi checkpoint WAL:', e);
      }

      const dbPath = path.join(__dirname, '..', 'data', 'inventory.db');
      if (!fs.existsSync(dbPath)) {
        return sendJson(res, 404, { error: 'Không tìm thấy file cơ sở dữ liệu' });
      }

      const dateStr = getLocalDateString().replace(/-/g, '');
      const filename = `inventory_${dateStr}.db`;

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      const stream = fs.createReadStream(dbPath);
      return stream.pipe(res);
    }

    if (pathname === '/api/backup/import' && method === 'POST') {
      const currentUser = getAuthenticatedUser(req);
      if (!currentUser || currentUser.role !== 'ADMIN') {
        return sendJson(res, 403, { error: 'Chỉ Admin mới có quyền khôi phục dữ liệu' });
      }

      const body = await parseRequestBody(req);
      if (!body || !body.data) {
        return sendJson(res, 400, { error: 'Dữ liệu sao lưu không đúng định dạng JSON hợp lệ' });
      }

      const d = body.data;
      let stats = { projects: 0, suppliers: 0, materials: 0, vehicles: 0, users: 0, tickets: 0 };

      function insertDynamic(table, rows) {
        if (!Array.isArray(rows) || rows.length === 0) return 0;
        let count = 0;
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.length === 0) continue;
          const placeholders = keys.map(() => '?').join(', ');
          const columns = keys.join(', ');
          const values = keys.map(k => row[k]);
          const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${placeholders})`);
          stmt.run(...values);
          count++;
        }
        return count;
      }

      // Tắt foreign_keys để tránh việc INSERT OR REPLACE users làm CASCADE DELETE phiên sessions đang đăng nhập
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN TRANSACTION;');
      try {
        if (Array.isArray(d.projects)) stats.projects = insertDynamic('projects', d.projects);
        if (Array.isArray(d.suppliers)) stats.suppliers = insertDynamic('suppliers', d.suppliers);
        if (Array.isArray(d.materials)) stats.materials = insertDynamic('materials', d.materials);
        if (Array.isArray(d.vehicles)) stats.vehicles = insertDynamic('vehicles', d.vehicles);
        if (Array.isArray(d.users)) stats.users = insertDynamic('users', d.users);
        if (Array.isArray(d.tickets)) stats.tickets = insertDynamic('tickets', d.tickets);

        db.exec('COMMIT;');
        db.exec('PRAGMA foreign_keys = ON;');
        return sendJson(res, 200, { success: true, message: 'Khôi phục dữ liệu thành công', stats });
      } catch (err) {
        db.exec('ROLLBACK;');
        db.exec('PRAGMA foreign_keys = ON;');
        console.error('Lỗi khi khôi phục dữ liệu:', err);
        return sendJson(res, 500, { error: 'Lỗi khôi phục cơ sở dữ liệu: ' + err.message });
      }
    }

    // =========================================================================
    // 9. PHỤC VỤ STATIC FILES
    // =========================================================================
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Truy cập bị từ chối');
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Lỗi máy chủ nội bộ');
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      });
    });

  } catch (error) {
    console.error('Lỗi xử lý request:', error);
    sendJson(res, 500, { error: error.message || 'Lỗi xử lý máy chủ' });
  }
});

function buildDailyExcelXml(date, summary, tickets) {
  let rows = '';
  let index = 1;

  for (const t of tickets) {
    const dim = (t.length > 0 && t.width > 0 && t.height > 0)
      ? `${t.length} x ${t.width} x ${t.height}`
      : 'Theo xe';
    const adjustText = t.is_manual_adjusted ? `Có (${t.adjustment_reason || 'Chở vơi/ngọn'})` : 'Đúng quy chuẩn';

    rows += `
    <Row>
      <Cell ss:StyleID="cCenter"><Data ss:Type="Number">${index++}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(t.ticket_code)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(t.project_name || 'Công trường')}</Data></Cell>
      <Cell ss:StyleID="cBold"><Data ss:Type="String">${escapeXml(t.plate_number)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(t.supplier_name)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(t.material_name)}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(t.unit || 'm³')}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(t.time_in)}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(t.time_out || 'Đang trong bãi')}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(dim)}</Data></Cell>
      <Cell ss:StyleID="cNumber"><Data ss:Type="Number">${t.standard_volume}</Data></Cell>
      <Cell ss:StyleID="cNumberBold"><Data ss:Type="Number">${t.actual_volume}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(adjustText)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(t.notes || '')}</Data></Cell>
    </Row>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11"/>
    </Style>
    <Style ss:ID="Title">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="16" ss:Bold="1" ss:Color="#0f172a"/>
    </Style>
    <Style ss:ID="SubTitle">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Italic="1" ss:Color="#475569"/>
    </Style>
    <Style ss:ID="Header">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
      </Borders>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#ffffff"/>
      <Interior ss:Color="#1e40af" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="TotalRow">
      <Alignment ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#1e40af"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#1e40af"/>
      </Borders>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#1e3a8a"/>
      <Interior ss:Color="#dbeafe" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="cCenter">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cBold">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cNumber">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cNumberBold">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#166534"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
  </Styles>
  <Worksheet ss:Name="Nhat_Trinh_Ngay">
    <Table ss:DefaultRowHeight="22">
      <Column ss:Width="40"/>
      <Column ss:Width="110"/>
      <Column ss:Width="160"/>
      <Column ss:Width="90"/>
      <Column ss:Width="180"/>
      <Column ss:Width="140"/>
      <Column ss:Width="50"/>
      <Column ss:Width="120"/>
      <Column ss:Width="120"/>
      <Column ss:Width="90"/>
      <Column ss:Width="80"/>
      <Column ss:Width="90"/>
      <Column ss:Width="120"/>
      <Column ss:Width="130"/>

      <Row ss:Height="30">
        <Cell ss:MergeAcross="13" ss:StyleID="Title"><Data ss:Type="String">NHẬT TRÌNH XUẤT NHẬP VẬT LIỆU XÂY DỰNG TẠI CÔNG TRƯỜNG</Data></Cell>
      </Row>
      <Row ss:Height="20">
        <Cell ss:MergeAcross="13" ss:StyleID="SubTitle"><Data ss:Type="String">Ngày: ${date} | Tổng số chuyến: ${summary.trips} chuyến</Data></Cell>
      </Row>
      <Row/>
      <Row ss:Height="26">
        <Cell ss:StyleID="Header"><Data ss:Type="String">STT</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Mã Phiếu</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Dự Án / Công Trường</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Biển Số Xe</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Nhà Cung Cấp</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Loại Vật Liệu</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">ĐVT</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Giờ Vào</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Giờ Ra</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Kích Thước (m)</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Quy Chuẩn</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Thực Nhận</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Điều Chỉnh</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Ghi Chú</Data></Cell>
      </Row>
      ${rows}
      <Row ss:Height="24" ss:StyleID="TotalRow">
        <Cell ss:MergeAcross="13" ss:StyleID="TotalRow"><Data ss:Type="String">TỔNG CỘNG HÔM NAY: ${summary.trips} LƯỢT XE HOÀN TẤT</Data></Cell>
      </Row>
    </Table>
  </Worksheet>
</Workbook>`;
}

function buildDailyExcelTemplateXml() {
  const sampleRows = `
    <Row>
      <Cell ss:StyleID="cCenter"><Data ss:Type="Number">1</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">HY-20260924-0001</Data></Cell>
      <Cell><Data ss:Type="String">Dự án KCN Hòa Yên</Data></Cell>
      <Cell ss:StyleID="cBold"><Data ss:Type="String">98RM 00549</Data></Cell>
      <Cell><Data ss:Type="String">Công ty TNHH Trí Thành</Data></Cell>
      <Cell><Data ss:Type="String">Đất san lấp / Đất đắp</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">m³</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">2026-09-24 07:30:00</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">2026-09-24 07:55:00</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">Theo xe</Data></Cell>
      <Cell ss:StyleID="cNumber"><Data ss:Type="Number">36.23</Data></Cell>
      <Cell ss:StyleID="cNumberBold"><Data ss:Type="Number">36.23</Data></Cell>
      <Cell><Data ss:Type="String">Đúng quy chuẩn</Data></Cell>
      <Cell><Data ss:Type="String">Nguồn: TRẠI CAU (Dòng mẫu)</Data></Cell>
    </Row>
    <Row>
      <Cell ss:StyleID="cCenter"><Data ss:Type="Number">2</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String"></Data></Cell>
      <Cell><Data ss:Type="String">Dự án KCN Hòa Yên</Data></Cell>
      <Cell ss:StyleID="cBold"><Data ss:Type="String">99C-123.45</Data></Cell>
      <Cell><Data ss:Type="String">Công ty Khang Minh</Data></Cell>
      <Cell><Data ss:Type="String">Cấp phối đá dăm Loại 1</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">m³</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">2026-09-24 08:15:00</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">2026-09-24 08:35:00</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">4.8 x 2.2 x 1.4</Data></Cell>
      <Cell ss:StyleID="cNumber"><Data ss:Type="Number">14.78</Data></Cell>
      <Cell ss:StyleID="cNumberBold"><Data ss:Type="Number">14.00</Data></Cell>
      <Cell><Data ss:Type="String">Chở vơi 0.78m³</Data></Cell>
      <Cell><Data ss:Type="String">Mã phiếu để trống sẽ tự sinh mã</Data></Cell>
    </Row>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11"/>
    </Style>
    <Style ss:ID="Title">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="16" ss:Bold="1" ss:Color="#0f172a"/>
    </Style>
    <Style ss:ID="SubTitle">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Italic="1" ss:Color="#475569"/>
    </Style>
    <Style ss:ID="Header">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
      </Borders>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#ffffff"/>
      <Interior ss:Color="#1e40af" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="cCenter">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cBold">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cNumber">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cNumberBold">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#166534"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
  </Styles>
  <Worksheet ss:Name="Nhat_Trinh_Ngay">
    <Table ss:DefaultRowHeight="22">
      <Column ss:Width="40"/>
      <Column ss:Width="120"/>
      <Column ss:Width="160"/>
      <Column ss:Width="100"/>
      <Column ss:Width="180"/>
      <Column ss:Width="160"/>
      <Column ss:Width="60"/>
      <Column ss:Width="130"/>
      <Column ss:Width="130"/>
      <Column ss:Width="100"/>
      <Column ss:Width="90"/>
      <Column ss:Width="90"/>
      <Column ss:Width="120"/>
      <Column ss:Width="150"/>

      <Row ss:Height="30">
        <Cell ss:MergeAcross="13" ss:StyleID="Title"><Data ss:Type="String">NHẬT TRÌNH XUẤT NHẬP VẬT LIỆU XÂY DỰNG TẠI CÔNG TRƯỜNG (MẪU NHẬP BỔ SUNG)</Data></Cell>
      </Row>
      <Row ss:Height="20">
        <Cell ss:MergeAcross="13" ss:StyleID="SubTitle"><Data ss:Type="String">Lưu ý: Cột Mã Phiếu có thể để trống để hệ thống tự sinh mã. Cột Giờ Vào/Ra nhập YYYY-MM-DD HH:mm:ss hoặc HH:mm.</Data></Cell>
      </Row>
      <Row/>
      <Row ss:Height="26">
        <Cell ss:StyleID="Header"><Data ss:Type="String">STT</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Mã Phiếu</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Dự Án / Công Trường</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Biển Số Xe</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Nhà Cung Cấp</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Loại Vật Liệu</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">ĐVT</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Giờ Vào</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Giờ Ra</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Kích Thước (m)</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Quy Chuẩn</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Thực Nhận</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Điều Chỉnh</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Ghi Chú</Data></Cell>
      </Row>
      ${sampleRows}
    </Table>
  </Worksheet>
</Workbook>`;
}

function buildCumulativeExcelXml(startDate, endDate, summary, data) {
  let rows = '';
  let index = 1;

  for (const item of data) {
    rows += `
    <Row>
      <Cell ss:StyleID="cCenter"><Data ss:Type="Number">${index++}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(item.project_name || 'Công trường')}</Data></Cell>
      <Cell ss:StyleID="cBold"><Data ss:Type="String">${escapeXml(item.supplier_name)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(item.material_name)}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(item.unit || 'm³')}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="String">${escapeXml(item.plate_number)}</Data></Cell>
      <Cell ss:StyleID="cCenter"><Data ss:Type="Number">${item.trips}</Data></Cell>
      <Cell ss:StyleID="cNumberBold"><Data ss:Type="Number">${item.volume}</Data></Cell>
    </Row>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11"/>
    </Style>
    <Style ss:ID="Title">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="16" ss:Bold="1" ss:Color="#0f172a"/>
    </Style>
    <Style ss:ID="SubTitle">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Italic="1" ss:Color="#475569"/>
    </Style>
    <Style ss:ID="Header">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#cbd5e1"/>
      </Borders>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#ffffff"/>
      <Interior ss:Color="#047857" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="TotalRow">
      <Alignment ss:Vertical="Center"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#047857"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#047857"/>
      </Borders>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#065f46"/>
      <Interior ss:Color="#d1fae5" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="cCenter">
      <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cBold">
      <Alignment ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
    <Style ss:ID="cNumberBold">
      <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
      <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#047857"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#e2e8f0"/></Borders>
    </Style>
  </Styles>
  <Worksheet ss:Name="Bao_Cao_Luy_Ke">
    <Table ss:DefaultRowHeight="22">
      <Column ss:Width="40"/>
      <Column ss:Width="180"/>
      <Column ss:Width="200"/>
      <Column ss:Width="150"/>
      <Column ss:Width="60"/>
      <Column ss:Width="100"/>
      <Column ss:Width="80"/>
      <Column ss:Width="120"/>

      <Row ss:Height="30">
        <Cell ss:MergeAcross="7" ss:StyleID="Title"><Data ss:Type="String">BÁO CÁO KHỐI LƯỢNG LŨY KẾ VẬT LIỆU THEO DỰ ÁN VÀ NHÀ CUNG CẤP</Data></Cell>
      </Row>
      <Row ss:Height="20">
        <Cell ss:MergeAcross="7" ss:StyleID="SubTitle"><Data ss:Type="String">Giai đoạn: Từ ${startDate} đến ${endDate} | Tổng lượt: ${summary.trips} lượt</Data></Cell>
      </Row>
      <Row/>
      <Row ss:Height="26">
        <Cell ss:StyleID="Header"><Data ss:Type="String">STT</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Dự Án / Công Trường</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Nhà Cung Cấp</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Loại Vật Liệu</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">ĐVT</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Biển Số Xe</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Số Chuyến</Data></Cell>
        <Cell ss:StyleID="Header"><Data ss:Type="String">Khối Lượng Lũy Kế</Data></Cell>
      </Row>
      ${rows}
      <Row ss:Height="24" ss:StyleID="TotalRow">
        <Cell ss:MergeAcross="5" ss:StyleID="TotalRow"><Data ss:Type="String">TỔNG LƯỢT XE GIAI ĐOẠN:</Data></Cell>
        <Cell ss:StyleID="TotalRow"><Data ss:Type="Number">${summary.trips}</Data></Cell>
        <Cell ss:StyleID="TotalRow"><Data ss:Type="String">Lượt</Data></Cell>
      </Row>
    </Table>
  </Worksheet>
</Workbook>`;
}

function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Khởi động lắng nghe cổng máy chủ HTTP (Zero-Dependency)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=====================================================`);
  console.log(` PHẦN MỀM QUẢN LÝ KHO VẬT LIỆU CÔNG TRƯỜNG`);
  console.log(` Máy chủ đang chạy tại: http://localhost:${PORT}`);
  console.log(` Mạng nội bộ: http://0.0.0.0:${PORT}`);
  console.log(` 💾 Trạng thái: SQLite Cục bộ (data/inventory.db)`);
  console.log(`=====================================================`);
});
