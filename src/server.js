// Máy chủ HTTP REST API & Phục vụ giao diện cho Phần mềm Quản lý Kho Vật Liệu Công Trường
// Hỗ trợ Đa Dự Án (Multi-project) & Đa Đơn Vị Tính (Tấn, m dài, m³, cái, bao...)
// Sử dụng node:http thuần & node:sqlite (Zero-Dependency)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db.js');

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

// Sinh mã phiếu theo ngày: NK-YYYYMMDD-XXXX
function generateTicketCode() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
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
      if (body.length > 5 * 1024 * 1024) { // giới hạn 5MB
        reject(new Error('Payload too large'));
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
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
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
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // =========================================================================
    // 0. API: QUẢN LÝ DỰ ÁN / CÔNG TRƯỜNG (PROJECTS)
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
      const body = await parseRequestBody(req);
      const name = (body.name || '').trim();
      const code = (body.code || '').trim().toUpperCase() || `DA-${Date.now().toString().slice(-4)}`;
      if (!name) return sendJson(res, 400, { error: 'Tên dự án/công trường không được để trống' });

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
      const id = parseInt(pathname.split('/')[3], 10);
      const usedTickets = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE project_id = ?').get(id).count;
      if (usedTickets > 0) {
        return sendJson(res, 400, { error: `Không thể xóa dự án này vì đã có ${usedTickets} lượt xe ghi nhận!` });
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 1. API: DASHBOARD (Hỗ trợ lọc theo Project)
    // =========================================================================
    if (pathname === '/api/dashboard' && method === 'GET') {
      const todayStr = getLocalDateString();
      const projectId = url.searchParams.get('projectId');

      let projectFilter = '';
      const params = [todayStr];
      if (projectId) {
        projectFilter = ' AND project_id = ?';
        params.push(parseInt(projectId, 10));
      }

      // Thống kê hôm nay
      const statsToday = db.prepare(`
        SELECT 
          COUNT(CASE WHEN status != 'CANCELLED' THEN 1 END) as total_trips,
          COUNT(CASE WHEN status = 'IN_YARD' THEN 1 END) as in_yard_count,
          COUNT(DISTINCT CASE WHEN status != 'CANCELLED' THEN supplier_id END) as active_suppliers
        FROM tickets
        WHERE date(time_in) = date(?) ${projectFilter}
      `).get(...params);

      // Thống kê khối lượng tổng hợp theo từng đơn vị tính hôm nay
      const volumeByUnitToday = db.prepare(`
        SELECT 
          unit,
          ROUND(SUM(actual_volume), 2) as total_volume
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY unit
      `).all(...params);

      // Thống kê theo loại vật liệu & đơn vị tính hôm nay
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

      // Thống kê theo khung giờ hôm nay
      const hourlyDistribution = db.prepare(`
        SELECT 
          strftime('%H', time_in) as hour,
          COUNT(*) as trips
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY hour
        ORDER BY hour ASC
      `).all(...params);

      // 10 lượt xe vào ra mới nhất
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
        stats: statsToday,
        volumeByUnit: volumeByUnitToday,
        materialBreakdown,
        hourlyDistribution,
        recentTickets
      });
    }

    // =========================================================================
    // 2. API: TỰ ĐỘNG TRA CỨU XE THEO BIỂN SỐ (AUTOCOMPLETE / QUICK LOOKUP)
    // =========================================================================
    if (pathname === '/api/vehicles/lookup' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim();
      if (!query) {
        return sendJson(res, 200, []);
      }

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

    // =========================================================================
    // 3. API: DANH MỤC XE (VEHICLES)
    // =========================================================================
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
      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 4. API: NHÀ CUNG CẤP (SUPPLIERS)
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
      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 5. API: LOẠI VẬT LIỆU (MATERIALS - Đa đơn vị tính: m³, Tấn, m, kg...)
    // =========================================================================
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
      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM materials WHERE id = ?').run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 6. API: QUẢN LÝ PHIẾU VÀO/RA (TICKETS & CHECK-IN / CHECK-OUT)
    // =========================================================================

    // Danh sách phiếu với các bộ lọc (date, status, supplier, material, search, project)
    if (pathname === '/api/tickets' && method === 'GET') {
      const status = url.searchParams.get('status');
      const date = url.searchParams.get('date');
      const supplierId = url.searchParams.get('supplierId');
      const materialId = url.searchParams.get('materialId');
      const projectId = url.searchParams.get('projectId');
      const search = (url.searchParams.get('search') || '').trim();

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

    // Danh sách các xe ĐANG TRONG BÃI (In-yard list, lọc theo project nếu có)
    if (pathname === '/api/tickets/in-yard' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
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
      const body = await parseRequestBody(req);
      const plate = (body.plate_number || '').trim().toUpperCase();
      if (!plate) return sendJson(res, 400, { error: 'Biển số xe không được để trống' });

      // Dự án
      let projectId = body.project_id ? parseInt(body.project_id, 10) : null;
      let projectName = (body.project_name || '').trim();
      if (projectId && !projectName) {
        const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
        if (proj) projectName = proj.name;
      }
      if (!projectName) {
        // Lấy dự án đầu tiên làm mặc định nếu có
        const defProj = db.prepare('SELECT id, name FROM projects ORDER BY id ASC LIMIT 1').get();
        if (defProj) {
          projectId = defProj.id;
          projectName = defProj.name;
        } else {
          projectName = 'Công trường chính';
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

      // Tìm thông tin Nhà cung cấp
      let supplierId = body.supplier_id ? parseInt(body.supplier_id, 10) : null;
      let supplierName = (body.supplier_name || '').trim();
      if (supplierId) {
        const supp = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplierId);
        if (supp) supplierName = supp.name;
      }

      // Tìm thông tin Vật liệu & Đơn vị tính
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

      if (!materialName) {
        return sendJson(res, 400, { error: 'Vui lòng chọn loại vật liệu chuyên chở' });
      }
      if (!supplierName) {
        return sendJson(res, 400, { error: 'Vui lòng chọn nhà cung cấp' });
      }

      const length = parseFloat(body.length) || 0;
      const width = parseFloat(body.width) || 0;
      const height = parseFloat(body.height) || 0;
      const standardVolume = parseFloat(body.standard_volume) || 0;

      // Xử lý khối lượng nghiệm thu
      const isManualAdjusted = body.is_manual_adjusted ? 1 : 0;
      let actualVolume = standardVolume;
      if (isManualAdjusted && body.actual_volume !== undefined && body.actual_volume !== null && body.actual_volume !== '') {
        actualVolume = parseFloat(body.actual_volume) || 0;
      }

      if (actualVolume <= 0) {
        return sendJson(res, 400, { error: `Khối lượng nghiệm thu phải lớn hơn 0 ${unit}` });
      }

      // Tự động lưu xe mới vào danh mục nếu chưa có
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
        body.created_by || 'Thủ kho / Cán bộ cổng',
        body.notes || '',
        timeIn
      );

      const createdTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid);
      return sendJson(res, 201, createdTicket);
    }

    // Xác nhận XE RA CỔNG (Check-out)
    if (pathname.match(/^\/api\/tickets\/\d+\/checkout$/) && method === 'POST') {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);

      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) return sendJson(res, 404, { error: 'Không tìm thấy phiếu xe vào' });
      if (ticket.status === 'COMPLETED') {
        return sendJson(res, 400, { error: 'Phiếu này đã xác nhận ra cổng trước đó' });
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
    if (pathname.match(/^\/api\/tickets\/\d+$/) && method === 'PUT') {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await parseRequestBody(req);

      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!ticket) return sendJson(res, 404, { error: 'Không tìm thấy phiếu' });

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

    // Hủy phiếu
    if (pathname.match(/^\/api\/tickets\/\d+$/) && method === 'DELETE') {
      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare("UPDATE tickets SET status = 'CANCELLED' WHERE id = ?").run(id);
      return sendJson(res, 200, { success: true, id });
    }

    // =========================================================================
    // 7. API: BÁO CÁO HÀNG NGÀY (DAILY REPORT - Phân rã theo Vật liệu & ĐVT)
    // =========================================================================
    if (pathname === '/api/reports/daily' && method === 'GET') {
      const date = url.searchParams.get('date') || getLocalDateString();
      const projectId = url.searchParams.get('projectId');

      let projectFilter = '';
      const params = [date];
      if (projectId) {
        projectFilter = ' AND project_id = ?';
        params.push(parseInt(projectId, 10));
      }

      // Danh sách tất cả các chuyến trong ngày
      const tickets = db.prepare(`
        SELECT * FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        ORDER BY time_in ASC
      `).all(...params);

      // Tổng hợp ngày
      const summary = db.prepare(`
        SELECT 
          COUNT(*) as total_trips,
          COUNT(DISTINCT supplier_name) as total_suppliers,
          COUNT(DISTINCT plate_number) as total_vehicles,
          COUNT(DISTINCT project_name) as total_projects
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
      `).get(...params);

      // Phân rã theo Loại vật liệu và Đơn vị tính
      const byMaterial = db.prepare(`
        SELECT 
          material_name,
          unit,
          COUNT(*) as trips,
          ROUND(SUM(actual_volume), 2) as volume
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY material_name, unit
        ORDER BY trips DESC
      `).all(...params);

      // Phân rã theo Nhà cung cấp
      const bySupplier = db.prepare(`
        SELECT 
          supplier_name,
          COUNT(*) as trips
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY supplier_name
        ORDER BY trips DESC
      `).all(...params);

      // Phân rã theo Dự án
      const byProject = db.prepare(`
        SELECT 
          project_id,
          project_name,
          COUNT(*) as trips
        FROM tickets
        WHERE date(time_in) = date(?) AND status != 'CANCELLED' ${projectFilter}
        GROUP BY project_name
        ORDER BY trips DESC
      `).all(...params);

      return sendJson(res, 200, {
        date,
        summary,
        byMaterial,
        bySupplier,
        byProject,
        tickets
      });
    }

    // =========================================================================
    // 8. API: BÁO CÁO KHỐI LƯỢNG LŨY KẾ (CUMULATIVE REPORT)
    // =========================================================================
    if (pathname === '/api/reports/cumulative' && method === 'GET') {
      const startDate = url.searchParams.get('startDate') || getLocalDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
      const endDate = url.searchParams.get('endDate') || getLocalDateString();
      const projectId = url.searchParams.get('projectId');
      const supplierId = url.searchParams.get('supplierId');
      const materialId = url.searchParams.get('materialId');

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

      // Tổng quan lũy kế
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

      // Bảng tổng hợp lũy kế theo từng Loại vật liệu (kèm đơn vị tính riêng biệt)
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

      // Bảng tổng hợp lũy kế theo Dự Án / Công Trường
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

      // Bảng tổng hợp lũy kế theo từng Nhà cung cấp
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

      // Bảng chi tiết sản lượng của từng Nhà cung cấp theo từng Loại vật liệu
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

      // Bảng chi tiết theo từng xe
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

    // =========================================================================
    // 9. API: XUẤT EXCEL BÁO CÁO (Hỗ trợ Dự án và Đơn vị tính)
    // =========================================================================
    if (pathname === '/api/reports/export-excel' && method === 'GET') {
      const type = url.searchParams.get('type') || 'daily';
      const date = url.searchParams.get('date') || getLocalDateString();
      const startDate = url.searchParams.get('startDate') || date;
      const endDate = url.searchParams.get('endDate') || date;
      const projectId = url.searchParams.get('projectId');

      let filename = `Bao_Cao_${type === 'daily' ? `Ngay_${date}` : `Luy_Ke_${startDate}_den_${endDate}`}.xls`;

      let xmlContent = '';
      if (type === 'daily') {
        let filterSql = `date(time_in) = date(?) AND status != 'CANCELLED'`;
        const params = [date];
        if (projectId) {
          filterSql += ` AND project_id = ?`;
          params.push(parseInt(projectId, 10));
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

    // =========================================================================
    // 10. PHỤC VỤ STATIC FILES (HTML, JS, CSS)
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

server.listen(PORT, () => {
  console.log(`=====================================================`);
  console.log(` PHẦN MỀM QUẢN LÝ KHO VẬT LIỆU CÔNG TRƯỜNG`);
  console.log(` Máy chủ đang chạy tại: http://localhost:3000`);
  console.log(` Mạng nội bộ: http://0.0.0.0:${PORT}`);
  console.log(`=====================================================`);
});
