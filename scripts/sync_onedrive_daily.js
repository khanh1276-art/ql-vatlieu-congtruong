const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const DOWNLOAD_DIR = path.join(APP_DIR, 'data', 'onedrive_download');
const SEED_DATA_PATH = path.join(APP_DIR, 'data', 'initial_seed.json');
const SEED_BACKUP_PATH = path.join(APP_DIR, 'data_seed', 'initial_seed.json');
const DB_PATH = path.join(APP_DIR, 'data', 'inventory.db');
const XLSX_PATH = path.join(DOWNLOAD_DIR, 'THEO DÕI NHẬP VẬT TƯ HOA YÊN.xlsx');

const xlsx = require(path.join(APP_DIR, 'public', 'xlsx.full.min.js'));
const WebSocket = require(path.join(APP_DIR, 'node_modules', 'ws'));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getChromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return 'chrome.exe';
  } else {
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return 'google-chrome';
  }
}

async function downloadFullWorkbook() {
  console.log('[ONEDRIVE] Khởi động Chrome CDP để tải sổ tính Excel trực tiếp...');
  if (fs.existsSync(DOWNLOAD_DIR)) {
    try { fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true }); } catch (e) {}
  }
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const chromePath = getChromePath();
  const userDataDir = path.join(APP_DIR, 'data', 'chrome_user_data_dl');
  if (fs.existsSync(userDataDir)) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  }

  const port = 9255;
  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1200,800'
  ];
  if (process.platform !== 'win32') {
    chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }

  console.log(`[CHROME] Khởi chạy: ${chromePath}`);
  const chrome = spawn(chromePath, chromeArgs);

  try {
    let version = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        version = await new Promise((res, rej) => {
          const req = http.get(`http://127.0.0.1:${port}/json/version`, r => {
            let b = ''; r.on('data', d => b += d);
            r.on('end', () => res(JSON.parse(b)));
          });
          req.on('error', rej);
          req.setTimeout(1500, () => req.destroy());
        });
        if (version && version.webSocketDebuggerUrl) break;
      } catch (e) {}
    }

    if (!version || !version.webSocketDebuggerUrl) {
      chrome.kill();
      throw new Error('Không thể kết nối Chrome DevTools Protocol sau 20s');
    }

    const bws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(r => bws.on('open', r));

    let bId = 1;
    function sendBrowser(method, params = {}) {
      return new Promise((res, rej) => {
        const msgId = bId++;
        const onMsg = (d) => {
          const m = JSON.parse(d.toString());
          if (m.id === msgId) {
            bws.off('message', onMsg);
            if (m.error) rej(m.error); else res(m.result);
          }
        };
        bws.send(JSON.stringify({ id: msgId, method, params }));
        bws.on('message', onMsg);
      });
    }

    await sendBrowser('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true
    });

    const downloadDonePromise = new Promise((resolve, reject) => {
      let filename = '';
      bws.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.method === 'Browser.downloadWillBegin') {
          filename = m.params.suggestedFilename;
          console.log('[DOWNLOAD] Bắt đầu tải:', filename);
        }
        if (m.method === 'Browser.downloadProgress') {
          if (m.params.state === 'completed') {
            console.log('[DOWNLOAD] Hoàn tất:', filename);
            resolve(filename);
          } else if (m.params.state === 'canceled') {
            reject(new Error('Download bị hủy'));
          }
        }
      });
    });

    const targets = await new Promise((res, rej) => {
      http.get(`http://127.0.0.1:${port}/json/list`, r => {
        let b = ''; r.on('data', d => b += d);
        r.on('end', () => res(JSON.parse(b)));
      }).on('error', rej);
    });
    const pageTarget = targets.find(t => t.type === 'page') || targets[0];
    const pws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise(r => pws.on('open', r));

    let pId = 1;
    function sendPage(method, params = {}) {
      return new Promise((res, rej) => {
        const msgId = pId++;
        const onMsg = (d) => {
          const m = JSON.parse(d.toString());
          if (m.id === msgId) {
            pws.off('message', onMsg);
            if (m.error) rej(m.error); else res(m.result);
          }
        };
        pws.send(JSON.stringify({ id: msgId, method, params }));
        pws.on('message', onMsg);
      });
    }

    await sendPage('Page.enable');
    await sendPage('Runtime.enable');

    const dlUrl = 'https://1drv.ms/x/c/5013fb151129ca84/IQD8QaKtFCt_QbgKBEZX0yiUAaMsFfXNZaLIOsHN2IuKwp4?download=1';
    console.log('[ONEDRIVE] Đang kích hoạt tải tệp .xlsx qua trình duyệt...');
    await sendPage('Runtime.evaluate', {
      expression: `(() => {
        const a = document.createElement('a');
        a.href = '${dlUrl}';
        document.body.appendChild(a);
        a.click();
      })()`
    });

    const downloadedFile = await Promise.race([
      downloadDonePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Hết thời gian chờ tải (60s)')), 60000))
    ]);

    console.log('[ONEDRIVE] Tải thành công:', downloadedFile);
    try { pws.close(); } catch (e) {}
    try { bws.close(); } catch (e) {}
    chrome.kill();
    return true;
  } catch (err) {
    try { chrome.kill(); } catch (e) {}
    console.error('[ONEDRIVE] Lỗi tải sổ tính:', err.message);
    throw err;
  }
}

function cleanPlate(s) {
  if (!s) return '';
  return String(s).replace(/[\s.\-]/g, '').toUpperCase();
}

function isPlate(val) {
  if (!val) return false;
  const s = String(val).trim().toUpperCase();
  if (s.length < 5 || s.length > 15) return false;
  if (/^(TỔNG|STT|KHÔNG|CHIỀU|ĐỢT|HẠNG|LOẠI|KÝ|CỘNG|NGÀY)/.test(s)) return false;
  return /^\d{2}[A-Z0-9\s.\-]{3,10}$/.test(s) && /[A-Z]/.test(s);
}

function parseIsoDate(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) {
    const pad = n => String(n).padStart(2, '0');
    return `${val.getFullYear()}-${pad(val.getMonth() + 1)}-${pad(val.getDate())}`;
  }
  if (typeof val === 'number' && val > 40000 && val < 55000) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    let p1 = parseInt(m[1], 10), p2 = parseInt(m[2], 10), yr = parseInt(m[3], 10);
    let day = p1, mo = p2;
    if (p2 > 12 && p1 <= 12) { mo = p1; day = p2; }
    const pad = n => String(n).padStart(2, '0');
    return `${yr}-${pad(mo)}-${pad(day)}`;
  }
  return null;
}

function parseNum(val) {
  if (!val) return 0;
  if (typeof val === 'number') return Math.round(val * 100) / 100;
  const n = parseFloat(String(val).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

async function processAllSheets() {
  console.log(`[PROCESS] Đang đồng bộ toàn bộ dữ liệu từ sổ tính OneDrive...`);

  const seed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf8'));
  const buf = fs.readFileSync(XLSX_PATH);
  const wb = xlsx.read(buf, { type: 'buffer' });

  const targetSheets = [
    'DAT TT (ĐỢT 1)',
    'DAT TT (ĐỢT 2)',
    'DAT ĐP',
    'DAT KM',
    'DAT PĐ',
    'CP LOAI II TT',
    'CP LOAI II TTR',
    'CONG',
    'BTXM'
  ];

  const odTrips = [];

  for (const sname of targetSheets) {
    const ws = wb.Sheets[sname];
    if (!ws) continue;

    const data = xlsx.utils.sheet_to_json(ws, { header: 1 });
    const startRow = (sname === 'CONG' || sname === 'BTXM') ? 49 : 43;
    let lastDate = null;

    for (let r = startRow; r < data.length; r++) {
      const row = data[r];
      if (!row || row.length < 5) continue;

      let plate = null;
      let plateCol = -1;
      for (let c = 0; c < Math.min(row.length, 15); c++) {
        if (isPlate(row[c])) {
          plate = String(row[c]).trim().toUpperCase();
          plateCol = c;
          break;
        }
      }
      if (!plate) continue;

      let d = null;
      for (let c = 0; c < plateCol; c++) {
        const cand = parseIsoDate(row[c]);
        if (cand) { d = cand; break; }
      }
      if (!d) {
        d = parseIsoDate(row[1]) || parseIsoDate(row[2]) || lastDate;
      }
      if (!d) continue;
      lastDate = d;

      let suppId = 4;
      let suppName = 'Công ty TNHH Trí Thành';
      let matId = 12;
      let matName = 'Đất san lấp / Đất đắp';
      let unit = 'm³';
      let notes = `Nguồn: Sheet ${sname}`;
      let vol = 0;

      if (sname === 'DAT TT (ĐỢT 1)') {
        suppId = 6;
        suppName = 'Công ty TNHH Trí Thành (Bãi Khởi Công)';
        vol = parseNum(row[11] || row[9] || row[8]);
      } else if (sname === 'DAT TT (ĐỢT 2)') {
        suppId = 4;
        suppName = 'Công ty TNHH Trí Thành';
        vol = parseNum(row[11] || row[9] || row[8]);
      } else if (sname === 'DAT ĐP') {
        suppId = 12;
        suppName = 'Công ty TNHH Đức Phúc (ĐP)';
        vol = parseNum(row[11] || row[9] || row[8]);
      } else if (sname === 'DAT KM') {
        suppId = 5;
        suppName = 'Công ty Khang Minh';
        vol = parseNum(row[11] || row[9] || row[8]);
      } else if (sname === 'DAT PĐ') {
        const phase = String(row[13] || '').trim();
        if (phase.includes('Đợt 3') || d >= '2026-06-01') {
          suppId = 8;
          suppName = 'Công ty TNHH Phát Đạt (PL02)';
          notes += ' | Đợt 3';
        } else {
          suppId = 7;
          suppName = 'Công ty TNHH Phát Đạt (PL01)';
          notes += ' | Đợt 1';
        }
        vol = parseNum(row[11] || row[9] || row[8]);
      } else if (sname === 'CP LOAI II TT') {
        suppId = 4;
        suppName = 'Công ty TNHH Trí Thành';
        matId = 14;
        matName = 'Cấp phối đá dăm loại 2 (Base B)';
        vol = parseNum(row[11] || row[9] || row[8]);
      } else if (sname === 'CP LOAI II TTR') {
        suppId = 9;
        suppName = 'Công ty TNHH Thảo Trang';
        matId = 14;
        matName = 'Cấp phối đá dăm loại 2 (Base B)';
        vol = parseNum(row[11] || row[9] || row[8]);
        if (row[12]) notes += ` | ${row[12]}`;
      } else if (sname === 'CONG') {
        suppId = 13;
        suppName = 'Công ty CP Avia (AMACCAO)';
        matId = 18;
        const rawMat = String(row[2] || '').trim();
        matName = rawMat ? `Cống bê tông (${rawMat})` : 'Cống bê tông';
        unit = 'm';
        vol = parseNum(row[11] || row[10]);
        if (rawMat) notes += ` | ${rawMat}`;
      } else if (sname === 'BTXM') {
        const rawMat = String(row[2] || '').trim();
        const rawSupp = String(row[4] || '').trim();
        const rawHm = String(row[3] || '').trim();
        matName = rawMat ? `Bê tông thương phẩm (${rawMat})` : 'Bê tông thương phẩm';
        matId = 17;
        unit = 'm³';
        if (rawSupp.includes('Chèm')) {
          suppId = 15;
          suppName = 'Bê tông Chèm';
        } else {
          suppId = 14;
          suppName = 'Bê tông Thiên Tân';
        }
        vol = parseNum(row[7]);
        notes += ` | ${rawMat}${rawHm ? ' | ' + rawHm : ''}`;
      }

      const orderVal = parseNum(row[0] || row[1]) || (r + 1);
      const cp = cleanPlate(plate);

      odTrips.push({
        sheet: sname,
        row: r + 1,
        date: d,
        plate,
        clean_plate: cp,
        supplier_id: suppId,
        supplier_name: suppName,
        material_id: matId,
        material_name: matName,
        unit,
        volume: vol,
        order: orderVal,
        notes
      });
    }
  }

  console.log(`[PROCESS] Trích xuất được ${odTrips.length} chuyến từ OneDrive.`);

  // Group OD trips by (date, clean_plate, supplier_id)
  const odByKey = {};
  for (const t of odTrips) {
    const key = `${t.date}_${t.clean_plate}_${t.supplier_id}`;
    if (!odByKey[key]) odByKey[key] = [];
    odByKey[key].push(t);
  }

  // Group existing tickets by (date, clean_plate, supplier_id)
  const exByKey = {};
  for (const t of seed.tickets) {
    const pId = t.project_id;
    if (pId === 4 || pId === 5 || (t.project_name && t.project_name.includes('Hòa Yên'))) {
      const d = (t.time_in || '').slice(0, 10);
      const cp = cleanPlate(t.plate_number);
      const suppId = t.supplier_id;
      const key = `${d}_${cp}_${suppId}`;
      if (!exByKey[key]) exByKey[key] = [];
      exByKey[key].push(t);
    }
  }

  for (const k in odByKey) odByKey[k].sort((a, b) => a.order - b.order);
  for (const k in exByKey) exByKey[k].sort((a, b) => (a.time_in || '').localeCompare(b.time_in || ''));

  let updatedVolumeCount = 0;
  const updatedTickets = [];
  const newTripsToInsert = [];

  for (const key in odByKey) {
    const odList = odByKey[key];
    const exList = exByKey[key] || [];

    for (let idx = 0; idx < odList.length; idx++) {
      const odTrip = odList[idx];
      if (idx < exList.length) {
        const exTicket = exList[idx];
        const oldVol = round2(exTicket.actual_volume);
        const newVol = odTrip.volume;

        if (Math.abs(oldVol - newVol) > 0.001 && newVol > 0) {
          updatedVolumeCount++;
          const prevStd = round2(exTicket.standard_volume);
          exTicket.actual_volume = newVol;
          if (prevStd === oldVol || prevStd === 0) {
            exTicket.standard_volume = newVol;
          }
          exTicket.is_manual_adjusted = 1;
          exTicket.adjustment_reason = 'Cập nhật khối lượng đối soát từ OneDrive (Sổ theo dõi Hòa Yên)';
          updatedTickets.push(exTicket);
        }
      } else {
        newTripsToInsert.push(odTrip);
      }
    }
  }

  console.log(`[PROCESS] Khối lượng thay đổi: ${updatedVolumeCount} vé, Số chuyến mới: ${newTripsToInsert.length}`);

  newTripsToInsert.sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : a.order - b.order));

  const dayCounters = {};
  const existingCodes = new Set(seed.tickets.map(t => t.ticket_code));

  for (const t of seed.tickets) {
    if (t.time_in) {
      const cDate = t.time_in.slice(0, 10).replace(/-/g, '');
      const m = (t.ticket_code || '').match(/-(\d{4})$/);
      const seq = m ? parseInt(m[1], 10) : 0;
      if (!dayCounters[cDate] || seq > dayCounters[cDate]) dayCounters[cDate] = seq;
    }
  }

  let maxTicketId = Math.max(...seed.tickets.map(t => t.id || 0), 0);
  const createdNewTickets = [];

  for (const trip of newTripsToInsert) {
    maxTicketId++;
    const compactDate = trip.date.replace(/-/g, '');
    dayCounters[compactDate] = (dayCounters[compactDate] || 0) + 1;
    let ticketCode = `HY-${compactDate}-${String(dayCounters[compactDate]).padStart(4, '0')}`;
    while (existingCodes.has(ticketCode)) {
      dayCounters[compactDate]++;
      ticketCode = `HY-${compactDate}-${String(dayCounters[compactDate]).padStart(4, '0')}`;
    }
    existingCodes.add(ticketCode);

    const startMinute = 6 * 60 + 30 + Math.min(dayCounters[compactDate] * 3, 11 * 60);
    const hour = Math.floor(startMinute / 60) % 24;
    const minute = startMinute % 60;
    const timeIn = `${trip.date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const timeOutMin = startMinute + 20;
    const timeOut = `${trip.date} ${String(Math.floor(timeOutMin / 60) % 24).padStart(2, '0')}:${String(timeOutMin % 60).padStart(2, '0')}:00`;

    const newTicket = {
      id: maxTicketId,
      ticket_code: ticketCode,
      vehicle_id: null,
      plate_number: trip.plate,
      supplier_id: trip.supplier_id,
      supplier_name: trip.supplier_name,
      material_id: trip.material_id,
      material_name: trip.material_name,
      time_in: timeIn,
      time_out: timeOut,
      length: 0,
      width: 0,
      height: 0,
      standard_volume: trip.volume,
      actual_volume: trip.volume,
      is_manual_adjusted: 0,
      adjustment_reason: '',
      status: 'CHECKED_OUT',
      created_by: 'Thủ kho Hòa Yên (Daily OneDrive Sync)',
      notes: trip.notes,
      created_at: timeIn,
      project_id: 5,
      project_name: 'Dự án Hòa Yên',
      unit: trip.unit
    };

    createdNewTickets.push(newTicket);
    seed.tickets.push(newTicket);
  }

  // Ensure all vehicle plates exist in seed.vehicles
  const existingPlates = new Set(seed.vehicles.map(v => cleanPlate(v.plate_number)));
  let maxVehId = Math.max(...seed.vehicles.map(v => v.id || 0), 0);
  for (const trip of odTrips) {
    if (!existingPlates.has(trip.clean_plate) && trip.clean_plate.length >= 6) {
      existingPlates.add(trip.clean_plate);
      maxVehId++;
      seed.vehicles.push({
        id: maxVehId,
        plate_number: trip.plate,
        model_type: 'Xe tải ben',
        supplier_id: trip.supplier_id,
        project_id: 5,
        length: 0,
        width: 0,
        height: 0,
        standard_volume: trip.volume || 0,
        unit: trip.unit,
        default_material_id: trip.material_id,
        notes: `Tự động tạo từ ${trip.notes}`,
        created_at: `${trip.date} 07:00:00`
      });
    }
  }

  if (updatedVolumeCount > 0 || createdNewTickets.length > 0) {
    fs.writeFileSync(SEED_DATA_PATH, JSON.stringify(seed, null, 2), 'utf8');
    fs.writeFileSync(SEED_BACKUP_PATH, JSON.stringify(seed, null, 2), 'utf8');
    console.log(`[FILE] Đã cập nhật initial_seed.json. Tổng vé: ${seed.tickets.length}`);

    try {
      const { seedFromInitialJsonIfAvailable } = require(path.join(APP_DIR, 'src', 'db.js'));
      const dbRes = seedFromInitialJsonIfAvailable(true);
      console.log('[SQLITE] Đồng bộ SQLite:', dbRes);
    } catch (dbErr) {
      console.error('[SQLITE] Lỗi cập nhật SQLite:', dbErr.message);
    }

    try {
      console.log('[GIT] Đang commit lên GitHub (nếu có quyền)...');
      execSync('git add data/initial_seed.json data_seed/initial_seed.json src/db.js', { cwd: APP_DIR });
      execSync(`git commit -m "feat(sync): dong bo toan bo du lieu OneDrive den ${new Date().toISOString().slice(0, 10)}"`, { cwd: APP_DIR });
      execSync('git push origin main', { cwd: APP_DIR });
      console.log('[GIT] Push thành công!');
    } catch (err) {
      console.warn('[GIT] Notice commit/push:', err.message);
    }

    const syncUrls = [
      'http://127.0.0.1:3000/api/sync-data',
      'https://kho.khanhtran.io.vn/api/sync-data'
    ];
    for (const url of syncUrls) {
      try {
        console.log(`[NOTIFY] Gửi tín hiệu làm mới đến: ${url}`);
        const syncRes = await fetch(url);
        const syncJson = await syncRes.json();
        console.log(`[NOTIFY] Kết quả từ ${url}:`, syncJson?.message || syncJson);
        break;
      } catch (err) {
        // thử link tiếp theo
      }
    }
  } else {
    console.log('[PROCESS] Không có thay đổi nào mới.');
  }

  return { updatedCount: updatedVolumeCount, insertedCount: createdNewTickets.length, totalTickets: seed.tickets.length };
}

function sendNotification(title, message) {
  if (process.platform === 'win32') {
    try {
      const scriptPath = path.join(APP_DIR, 'tools', 'notify.ps1');
      if (fs.existsSync(scriptPath)) {
        execSync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}" -Title "${title}" -Message "${message}"`, { stdio: 'ignore' });
      }
    } catch (e) {}
  } else {
    console.log(`[NOTIFY] ${title}: ${message}`);
  }
}

async function runDailySync() {
  console.log(`\n======================================================`);
  console.log(`[DAILY SYNC] BẮT ĐẦU ĐỒNG BỘ TOÀN BỘ CÁC SHEET: ${new Date().toLocaleString('vi-VN')}`);
  console.log(`======================================================`);

  try {
    await downloadFullWorkbook();
    const res = await processAllSheets();
    console.log(`\n[HOÀN TẤT] Đồng bộ hoàn thành. Cập nhật: ${res.updatedCount}, Mới: ${res.insertedCount}`);
    sendNotification(
      'Dong Bo OneDrive - Quan Ly Kho',
      `Dong bo thanh cong! Tong: ${res.totalTickets} ve (Them moi: ${res.insertedCount}, Doi soat: ${res.updatedCount})`
    );
  } catch (err) {
    console.error(`\n[LỖI] Tiến trình đồng bộ gặp sự cố:`, err);
    sendNotification(
      'Loi Dong Bo OneDrive',
      `Su co dong bo: ${err.message || 'Khong the ket noi OneDrive'}`
    );
  }
}

if (require.main === module) {
  runDailySync();
}

module.exports = { runDailySync, downloadFullWorkbook, processAllSheets };
