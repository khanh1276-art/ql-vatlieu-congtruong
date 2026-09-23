// Logic tương tác Frontend cho Phần mềm Quản lý Kho Vật Liệu Công Trường
// Hỗ trợ: Đa Dự Án, Đa Đơn Vị Tính, Phân Quyền Bảo Mật & Khóa Số Liệu Qua Ngày (Time-lock)

const AppState = {
  currentTab: 'checkin',
  selectedProjectId: '', // Rỗng nghĩa là xem "Tất cả dự án" (chỉ Admin)
  currentUser: null,
  token: localStorage.getItem('auth_token') || '',
  projects: [],
  suppliers: [],
  materials: [],
  vehicles: [],
  users: [],
  inYardTickets: [],
  dailyTickets: [],
  activeCheckoutTicket: null,
  hourlyChart: null,
  plateDebounceTimer: null
};

// ============================================================================
// 1. API FETCH WRAPPER (TỰ ĐỘNG GẮN TOKEN & BẢO MẬT)
// ============================================================================
async function apiFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (AppState.token) {
    headers['Authorization'] = `Bearer ${AppState.token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('Chưa đăng nhập hoặc phiên làm việc đã hết hạn');
  }
  return res;
}

// ============================================================================
// 2. KHỞI TẠO, ĐỒNG HỒ THỜI GIAN THỰC & XÁC THỰC
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  initDates();
  checkAuth();

  // Tự động làm mới xe trong bãi mỗi 20 giây nếu đang ở tab vào/ra hoặc dashboard
  setInterval(() => {
    if (AppState.currentUser && (AppState.currentTab === 'checkin' || AppState.currentTab === 'dashboard')) {
      loadInYardTickets(false);
      loadDashboardStats();
    }
  }, 20000);

  // Đóng dropdown gợi ý biển số khi click ra ngoài
  document.addEventListener('click', (e) => {
    const box = document.getElementById('plateSuggestions');
    const input = document.getElementById('checkin_plate');
    if (box && !box.contains(e.target) && e.target !== input) {
      box.classList.add('hidden');
    }
  });
});

function startClock() {
  const clockEl = document.getElementById('liveClock');
  const dateEl = document.getElementById('liveDate');

  const update = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (clockEl) {
      clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    if (dateEl) {
      const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
      dateEl.textContent = `${days[now.getDay()]}, ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    }
  };
  update();
  setInterval(update, 1000);
}

function initDates() {
  const todayStr = getTodayDateStr();
  const dailyDateInput = document.getElementById('dailyReportDate');
  if (dailyDateInput) dailyDateInput.value = todayStr;

  const cumStart = document.getElementById('cumStartDate');
  const cumEnd = document.getElementById('cumEndDate');
  if (cumEnd) cumEnd.value = todayStr;
  if (cumStart) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    cumStart.value = formatDateForInput(d);
  }
}

function getTodayDateStr() {
  return formatDateForInput(new Date());
}

function formatDateForInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ============================================================================
// 3. XÁC THỰC NGƯỜI DÙNG & PHÂN QUYỀN (AUTHENTICATION & RBAC)
// ============================================================================
async function checkAuth() {
  if (!AppState.token) {
    handleUnauthorized();
    return;
  }

  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${AppState.token}` }
    });

    if (!res.ok) {
      handleUnauthorized();
      return;
    }

    const user = await res.json();
    onLoginSuccess(user, AppState.token, false);
  } catch (err) {
    console.error('Lỗi kiểm tra phiên:', err);
    handleUnauthorized();
  }
}

async function handleLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = (document.getElementById('loginUsername')?.value || '').trim();
  const password = document.getElementById('loginPassword')?.value || '';
  const errorDiv = document.getElementById('loginError');
  const btn = document.getElementById('btnLoginSubmit');

  if (errorDiv) {
    errorDiv.classList.add('hidden');
    errorDiv.textContent = '';
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Đang xác thực...</span>';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Đăng nhập không thành công');
    }

    onLoginSuccess(data.user, data.token, true);
  } catch (err) {
    if (errorDiv) {
      errorDiv.textContent = err.message;
      errorDiv.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>ĐĂNG NHẬP HỆ THỐNG</span>';
    }
  }
}

function quickFillLogin(username, password) {
  const uInput = document.getElementById('loginUsername');
  const pInput = document.getElementById('loginPassword');
  if (uInput) uInput.value = username;
  if (pInput) pInput.value = password;
  const form = document.getElementById('loginForm');
  if (form) form.requestSubmit();
}

function onLoginSuccess(user, token, showGreeting = false) {
  AppState.currentUser = user;
  AppState.token = token;
  localStorage.setItem('auth_token', token);

  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.add('hidden');

  applyUserRolePermissions(user);
  loadInitialData();

  if (showGreeting) {
    const roleTitle = user.role === 'ADMIN' ? 'Admin Văn Phòng' : `Công Trường (${user.project_name || 'Dự án'})`;
    showToast(`✓ Xin chào ${user.full_name} [${roleTitle}]!`, 'success');
  }
}

async function handleLogout() {
  if (!confirm('Bạn có chắc chắn muốn đăng xuất khỏi hệ thống?')) return;
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AppState.token}` }
    });
  } catch (e) {
    // Bỏ qua lỗi mạng khi logout
  }
  handleUnauthorized();
  showToast('Đã đăng xuất tài khoản', 'info');
}

function handleUnauthorized() {
  AppState.currentUser = null;
  AppState.token = '';
  localStorage.removeItem('auth_token');

  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.classList.remove('hidden');

  const form = document.getElementById('loginForm');
  if (form) form.reset();

  const errorDiv = document.getElementById('loginError');
  if (errorDiv) errorDiv.classList.add('hidden');

  // Khôi phục giao diện mặc định
  const uName = document.getElementById('userDisplayName');
  if (uName) uName.textContent = 'Chưa đăng nhập';
  const uBadge = document.getElementById('userRoleBadge');
  if (uBadge) uBadge.textContent = 'Khách';
}

function applyUserRolePermissions(user) {
  // 1. Tên hiển thị & Vai trò
  const uName = document.getElementById('userDisplayName');
  if (uName) uName.textContent = user.full_name || user.username;

  const uBadge = document.getElementById('userRoleBadge');
  if (uBadge) {
    if (user.role === 'ADMIN') {
      uBadge.textContent = '👑 Admin Văn Phòng';
      uBadge.className = 'text-[10px] text-amber-400 font-semibold leading-tight';
    } else {
      uBadge.textContent = `🚚 ${user.project_name || 'Cán Bộ Công Trường'}`;
      uBadge.className = 'text-[10px] text-blue-300 font-semibold leading-tight';
    }
  }

  // 2. Khung dự án trên Header
  const scopeBox = document.getElementById('projectHeaderScopeBox');
  if (scopeBox) {
    if (user.role === 'ADMIN') {
      scopeBox.innerHTML = `
        <span class="text-slate-400 text-xs font-medium">Dự án:</span>
        <select id="headerProjectSelect" onchange="handleHeaderProjectChange()"
          class="bg-slate-900 text-white text-xs font-semibold rounded px-2 py-1 border border-slate-700 focus:outline-none focus:border-blue-500">
        </select>
      `;
    } else {
      // Công trường bị khóa cố định vào đúng dự án của mình
      AppState.selectedProjectId = user.project_id || '';
      scopeBox.innerHTML = `
        <span class="text-slate-400 text-xs font-medium">Dự án trực thuộc:</span>
        <span class="text-xs font-bold text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800">
          🏗️ ${escapeHtml(user.project_name || 'Công trường phụ trách')}
        </span>
      `;
    }
  }

  // 3. Tab Cấu hình & Tài khoản (Chỉ Admin mới có)
  const navSettings = document.getElementById('navSettingsTab');
  if (navSettings) {
    if (user.role === 'ADMIN') {
      navSettings.classList.remove('hidden');
    } else {
      navSettings.classList.add('hidden');
      if (AppState.currentTab === 'settings') {
        switchTab('checkin');
      }
    }
  }
}

// ============================================================================
// 4. NẠP DỮ LIỆU BAN ĐẦU
// ============================================================================
async function loadInitialData() {
  await Promise.all([
    loadProjects(),
    loadSuppliers(),
    loadMaterials(),
    loadVehicles()
  ]);

  loadInYardTickets();
  loadDashboardStats();
}

// ============================================================================
// 5. QUẢN LÝ DỰ ÁN & BỘ CHỌN DỰ ÁN (PROJECT SWITCHER)
// ============================================================================
async function loadProjects() {
  try {
    const res = await apiFetch('/api/projects');
    AppState.projects = await res.json();
    populateProjectDropdowns();
  } catch (err) {
    console.error('Lỗi tải danh mục dự án:', err);
  }
}

function populateProjectDropdowns() {
  const isAdmin = AppState.currentUser && AppState.currentUser.role === 'ADMIN';

  const headerSel = document.getElementById('headerProjectSelect');
  const checkinSel = document.getElementById('checkin_project');
  const dailySel = document.getElementById('dailyProjectFilter');
  const cumSel = document.getElementById('cumProjectFilter');
  const vehSel = document.getElementById('veh_project');
  const usrProjSel = document.getElementById('usr_project');

  const optionsFilter = '<option value="">-- Tất cả dự án --</option>' +
    AppState.projects.map(p => `<option value="${p.id}" ${AppState.selectedProjectId == p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  const optionsRequired = '<option value="">-- Chọn dự án tiếp nhận --</option>' +
    AppState.projects.map(p => `<option value="${p.id}" ${AppState.selectedProjectId == p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  if (headerSel) headerSel.innerHTML = optionsFilter;
  if (dailySel) {
    dailySel.innerHTML = optionsFilter;
    if (!isAdmin && AppState.currentUser?.project_id) {
      dailySel.value = AppState.currentUser.project_id;
      dailySel.disabled = true;
    } else {
      dailySel.disabled = false;
    }
  }
  if (cumSel) {
    cumSel.innerHTML = optionsFilter;
    if (!isAdmin && AppState.currentUser?.project_id) {
      cumSel.value = AppState.currentUser.project_id;
      cumSel.disabled = true;
    } else {
      cumSel.disabled = false;
    }
  }
  if (vehSel) vehSel.innerHTML = '<option value="">-- Chọn dự án thường trực --</option>' + AppState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (usrProjSel) usrProjSel.innerHTML = '<option value="">-- Chọn dự án phân công --</option>' + AppState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (checkinSel) {
    checkinSel.innerHTML = optionsRequired;
    if (!isAdmin && AppState.currentUser?.project_id) {
      checkinSel.value = AppState.currentUser.project_id;
      checkinSel.disabled = true;
    } else {
      checkinSel.disabled = false;
      if (AppState.selectedProjectId) checkinSel.value = AppState.selectedProjectId;
    }
  }
}

function handleHeaderProjectChange() {
  const sel = document.getElementById('headerProjectSelect');
  AppState.selectedProjectId = sel ? sel.value : '';

  // Đồng bộ sang form checkin và bộ lọc báo cáo
  const checkinSel = document.getElementById('checkin_project');
  if (checkinSel && AppState.selectedProjectId && !checkinSel.disabled) {
    checkinSel.value = AppState.selectedProjectId;
  }

  const dailySel = document.getElementById('dailyProjectFilter');
  if (dailySel && !dailySel.disabled) dailySel.value = AppState.selectedProjectId;

  const cumSel = document.getElementById('cumProjectFilter');
  if (cumSel && !cumSel.disabled) cumSel.value = AppState.selectedProjectId;

  // Làm mới dữ liệu tab hiện tại
  if (AppState.currentTab === 'checkin') {
    loadInYardTickets();
  } else if (AppState.currentTab === 'dashboard') {
    loadDashboardStats();
  } else if (AppState.currentTab === 'daily') {
    loadDailyReport();
  } else if (AppState.currentTab === 'cumulative') {
    loadCumulativeReport();
  }
}

// ============================================================================
// 6. CHUYỂN TAB VÀ ĐIỀU HƯỚNG
// ============================================================================
function switchTab(tabId) {
  // Chặn Site User vào tab Cấu hình
  if (tabId === 'settings' && AppState.currentUser?.role !== 'ADMIN') {
    showToast('Tài khoản công trường không có quyền truy cập Cấu hình & Quản lý', 'error');
    return;
  }

  AppState.currentTab = tabId;

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    if (btn.dataset.tab === tabId) {
      btn.className = 'nav-tab active-tab flex items-center space-x-2 px-3 py-2 rounded-md transition text-white bg-blue-600 font-semibold';
    } else {
      btn.className = 'nav-tab flex items-center space-x-2 px-3 py-2 rounded-md transition text-slate-300 hover:text-white hover:bg-slate-800 font-medium';
    }
  });

  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.add('hidden');
  });

  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) activePane.classList.remove('hidden');

  if (tabId === 'checkin') {
    loadInYardTickets();
    loadDashboardStats();
  } else if (tabId === 'dashboard') {
    loadDashboardStats();
  } else if (tabId === 'daily') {
    loadDailyReport();
  } else if (tabId === 'cumulative') {
    loadCumulativeReport();
  } else if (tabId === 'settings') {
    switchSettingsSubTab('users');
  }
}

// ============================================================================
// 7. NẠP DANH MỤC CƠ BẢN (SUPPLIERS, MATERIALS, VEHICLES)
// ============================================================================
async function loadSuppliers() {
  try {
    const res = await apiFetch('/api/suppliers');
    AppState.suppliers = await res.json();
    populateSupplierDropdowns();
  } catch (err) {
    console.error('Lỗi tải danh mục nhà cung cấp:', err);
  }
}

function populateSupplierDropdowns() {
  const checkinSel = document.getElementById('checkin_supplier');
  const vehSel = document.getElementById('veh_supplier');
  const cumSel = document.getElementById('cumSupplierFilter');

  const options = '<option value="">-- Chọn nhà cung cấp --</option>' +
    AppState.suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  if (checkinSel) checkinSel.innerHTML = options;
  if (vehSel) vehSel.innerHTML = options;
  if (cumSel) {
    cumSel.innerHTML = '<option value="">-- Tất cả nhà cung cấp --</option>' +
      AppState.suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  }
}

async function loadMaterials() {
  try {
    const res = await apiFetch('/api/materials');
    AppState.materials = await res.json();
    populateMaterialDropdowns();
  } catch (err) {
    console.error('Lỗi tải danh mục vật liệu:', err);
  }
}

function populateMaterialDropdowns() {
  const checkinSel = document.getElementById('checkin_material');
  const vehSel = document.getElementById('veh_material');
  const cumSel = document.getElementById('cumMaterialFilter');

  const options = '<option value="">-- Chọn loại vật liệu --</option>' +
    AppState.materials.map(m => `<option value="${m.id}" data-unit="${escapeHtml(m.unit || 'm³')}">${escapeHtml(m.name)} (${escapeHtml(m.unit || 'm³')})</option>`).join('');

  if (checkinSel) checkinSel.innerHTML = options;
  if (vehSel) vehSel.innerHTML = options;
  if (cumSel) {
    cumSel.innerHTML = '<option value="">-- Tất cả vật liệu --</option>' +
      AppState.materials.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  }
}

async function loadVehicles() {
  try {
    const res = await apiFetch('/api/vehicles');
    AppState.vehicles = await res.json();
  } catch (err) {
    console.error('Lỗi tải danh mục xe:', err);
  }
}

// ============================================================================
// 8. FORM CHECK-IN: GỢI Ý BIỂN SỐ & TÍNH TOÁN QUY CÁCH
// ============================================================================
function getCheckinUnit() {
  const hiddenUnit = document.getElementById('checkin_unit');
  if (hiddenUnit && hiddenUnit.value) return hiddenUnit.value;
  const matSel = document.getElementById('checkin_material');
  if (matSel && matSel.selectedIndex >= 0) {
    const opt = matSel.options[matSel.selectedIndex];
    if (opt && opt.dataset && opt.dataset.unit) return opt.dataset.unit;
  }
  const badge = document.getElementById('checkinStdUnitBadge') || document.getElementById('unitBadgeStd');
  if (badge && badge.textContent) return badge.textContent.trim();
  return 'm³';
}

function handlePlateInput(arg) {
  const input = document.getElementById('checkin_plate');
  const query = (typeof arg === 'string' ? arg : (arg?.target?.value || (input ? input.value : ''))).trim().toUpperCase();
  if (input && input.value !== query) input.value = query;

  clearTimeout(AppState.plateDebounceTimer);
  const box = document.getElementById('plateSuggestions');
  if (!box) return;

  if (query.length < 2) {
    box.classList.add('hidden');
    return;
  }

  AppState.plateDebounceTimer = setTimeout(() => {
    const matches = AppState.vehicles.filter(v => v.plate_number.includes(query)).slice(0, 6);
    if (matches.length === 0) {
      box.classList.add('hidden');
      return;
    }

    box.innerHTML = matches.map(v => `
      <div onclick="selectVehicleSuggestion('${v.plate_number}')"
        class="px-3 py-2 text-xs hover:bg-blue-50 cursor-pointer border-b border-slate-100 flex items-center justify-between">
        <div>
          <span class="font-mono font-bold text-slate-800">${v.plate_number}</span>
          <span class="text-slate-400 ml-1">(${escapeHtml(v.supplier_name || 'Chưa gán NCC')})</span>
        </div>
        <div class="text-right">
          <span class="font-bold text-blue-700">${v.standard_volume.toFixed(2)} ${v.unit || 'm³'}</span>
        </div>
      </div>
    `).join('');
    box.classList.remove('hidden');
  }, 150);
}

function selectVehicleSuggestion(plate) {
  const v = AppState.vehicles.find(item => item.plate_number === plate);
  const box = document.getElementById('plateSuggestions');
  if (box) box.classList.add('hidden');

  if (!v) return;

  const plateIn = document.getElementById('checkin_plate');
  if (plateIn) plateIn.value = v.plate_number;

  const modelIn = document.getElementById('checkin_model');
  if (modelIn) modelIn.value = v.model_type || '';

  const suppSel = document.getElementById('checkin_supplier');
  if (suppSel && v.supplier_id) suppSel.value = v.supplier_id;

  const projSel = document.getElementById('checkin_project');
  if (projSel && v.project_id && !projSel.disabled) {
    projSel.value = v.project_id;
  }

  if (v.default_material_id) {
    const matSel = document.getElementById('checkin_material');
    if (matSel) {
      matSel.value = v.default_material_id;
      handleCheckinMaterialChange();
    }
  }

  const lIn = document.getElementById('checkin_length');
  if (lIn) lIn.value = v.length || '';
  const wIn = document.getElementById('checkin_width');
  if (wIn) wIn.value = v.width || '';
  const hIn = document.getElementById('checkin_height');
  if (hIn) hIn.value = v.height || '';

  const stdIn = document.getElementById('checkin_std_volume');
  if (stdIn) stdIn.value = v.standard_volume || '';

  const unit = v.unit || 'm³';
  const hiddenUnit = document.getElementById('checkin_unit');
  if (hiddenUnit) hiddenUnit.value = unit;

  const stdBadge = document.getElementById('checkinStdUnitBadge') || document.getElementById('unitBadgeStd');
  if (stdBadge) stdBadge.textContent = unit;
  const actBadge = document.getElementById('checkinActualUnitBadge') || document.getElementById('unitBadgeActual');
  if (actBadge) actBadge.textContent = unit;

  calculateGeoVolume();
  syncStdVolumeToActual();

  const hint = document.getElementById('plateHint');
  if (hint) {
    hint.textContent = `✓ Đã khớp xe ${v.plate_number}: Định mức ${v.standard_volume.toFixed(2)} ${unit}`;
    hint.className = 'text-xs text-emerald-600 mt-1 font-semibold';
  }
}

function handleCheckinMaterialChange() {
  const sel = document.getElementById('checkin_material');
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const unit = opt?.dataset?.unit || 'm³';

  const hiddenUnit = document.getElementById('checkin_unit');
  if (hiddenUnit) hiddenUnit.value = unit;

  const stdBadge = document.getElementById('checkinStdUnitBadge') || document.getElementById('unitBadgeStd');
  if (stdBadge) stdBadge.textContent = unit;

  const actualBadge = document.getElementById('checkinActualUnitBadge') || document.getElementById('unitBadgeActual');
  if (actualBadge) actualBadge.textContent = unit;

  calculateGeoVolume();
}
const onMaterialChange = handleCheckinMaterialChange;

function calculateGeoVolume() {
  const l = parseFloat(document.getElementById('checkin_length')?.value) || 0;
  const w = parseFloat(document.getElementById('checkin_width')?.value) || 0;
  const h = parseFloat(document.getElementById('checkin_height')?.value) || 0;
  const vol = l * w * h;

  const geoLabel = document.getElementById('calculatedGeoVol');
  if (geoLabel) {
    geoLabel.textContent = vol > 0 ? `Thể tích: ${vol.toFixed(2)} m³` : 'Thể tích: 0.00 m³';
  }

  const unit = getCheckinUnit();
  const stdIn = document.getElementById('checkin_std_volume');
  if (stdIn && !stdIn.value && vol > 0 && unit === 'm³') {
    stdIn.value = vol.toFixed(2);
    syncStdVolumeToActual();
  }
}
const calcGeoVolume = calculateGeoVolume;

function syncStdVolumeToActual() {
  const stdVal = document.getElementById('checkin_std_volume')?.value;
  const actualIn = document.getElementById('checkin_actual_volume');
  const manualToggle = document.getElementById('checkin_manual_toggle');
  if (actualIn && (!manualToggle || !manualToggle.checked) && stdVal) {
    actualIn.value = stdVal;
  }
}

function toggleManualAdjustment() {
  const isChecked = !!document.getElementById('checkin_manual_toggle')?.checked;
  const box = document.getElementById('manualAdjustmentBox') || document.getElementById('manualAdjustWrap');
  const actualIn = document.getElementById('checkin_actual_volume');
  const reasonIn = document.getElementById('checkin_adjust_reason');

  if (box) {
    if (isChecked) {
      box.classList.remove('hidden');
      if (actualIn) {
        actualIn.setAttribute('required', 'required');
        if (!actualIn.value) {
          actualIn.value = document.getElementById('checkin_std_volume')?.value || '';
        }
      }
      if (reasonIn) reasonIn.setAttribute('required', 'required');
    } else {
      box.classList.add('hidden');
      if (actualIn) {
        actualIn.removeAttribute('required');
        actualIn.value = document.getElementById('checkin_std_volume')?.value || '';
      }
      if (reasonIn) {
        reasonIn.removeAttribute('required');
        reasonIn.value = '';
      }
    }
  }
}

// ============================================================================
// 9. CHECK-IN XE VÀO CỔNG
// ============================================================================
async function handleCheckIn(event) {
  if (event && event.preventDefault) event.preventDefault();

  const plate = (document.getElementById('checkin_plate')?.value || '').trim().toUpperCase();
  const projectId = document.getElementById('checkin_project')?.value || '';
  const supplierId = document.getElementById('checkin_supplier')?.value || '';
  const materialId = document.getElementById('checkin_material')?.value || '';
  const modelType = (document.getElementById('checkin_model')?.value || '').trim();
  const unit = getCheckinUnit();

  const length = parseFloat(document.getElementById('checkin_length')?.value) || 0;
  const width = parseFloat(document.getElementById('checkin_width')?.value) || 0;
  const height = parseFloat(document.getElementById('checkin_height')?.value) || 0;
  const stdVolume = parseFloat(document.getElementById('checkin_std_volume')?.value) || 0;

  const isManual = !!document.getElementById('checkin_manual_toggle')?.checked;
  const actualVolume = isManual ? (parseFloat(document.getElementById('checkin_actual_volume')?.value) || 0) : stdVolume;
  const adjustReason = isManual ? (document.getElementById('checkin_adjust_reason')?.value || '').trim() : '';
  const notes = (document.getElementById('checkin_notes')?.value || '').trim();

  if (!plate) {
    showToast('Vui lòng nhập biển số xe', 'error');
    return;
  }
  if (!projectId) {
    showToast('Vui lòng chọn Dự án tiếp nhận', 'error');
    return;
  }
  if (!supplierId) {
    showToast('Vui lòng chọn Nhà cung cấp', 'error');
    return;
  }
  if (!materialId) {
    showToast('Vui lòng chọn Loại vật liệu', 'error');
    return;
  }
  if (stdVolume <= 0) {
    showToast(`Định mức quy chuẩn theo xe phải lớn hơn 0 ${unit}`, 'error');
    return;
  }
  if (actualVolume <= 0) {
    showToast(`Khối lượng nghiệm thu phải lớn hơn 0 ${unit}`, 'error');
    return;
  }
  if (isManual && !adjustReason) {
    showToast('Vui lòng ghi rõ lý do điều chỉnh khi có sai khác so với định mức', 'error');
    return;
  }

  const payload = {
    plate_number: plate,
    model_type: modelType,
    project_id: parseInt(projectId, 10),
    supplier_id: parseInt(supplierId, 10),
    material_id: parseInt(materialId, 10),
    unit,
    length,
    width,
    height,
    standard_volume: stdVolume,
    actual_volume: actualVolume,
    is_manual_adjusted: isManual ? 1 : 0,
    adjustment_reason: adjustReason,
    notes
  };

  const btn = document.getElementById('btnSubmitCheckIn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Đang ghi nhận...</span>';
  }

  try {
    const res = await apiFetch('/api/tickets/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lỗi khi ghi nhận xe vào');
    }

    showToast(`✓ Đã ghi nhận xe ${data.plate_number} vào ${data.project_name || 'công trường'}! (${data.actual_volume} ${data.unit})`, 'success');

    loadVehicles();

    // Reset form
    const form = document.getElementById('checkInForm');
    if (form) form.reset();

    if (AppState.currentUser?.role === 'SITE_USER') {
      const projSel = document.getElementById('checkin_project');
      if (projSel) projSel.value = AppState.currentUser.project_id;
    } else if (AppState.selectedProjectId) {
      const projSel = document.getElementById('checkin_project');
      if (projSel) projSel.value = AppState.selectedProjectId;
    }

    const manualToggle = document.getElementById('checkin_manual_toggle');
    if (manualToggle) manualToggle.checked = false;
    toggleManualAdjustment();

    const geoLabel = document.getElementById('calculatedGeoVol');
    if (geoLabel) geoLabel.textContent = 'Thể tích: 0.00 m³';

    const hint = document.getElementById('plateHint');
    if (hint) {
      hint.textContent = 'Gõ biển số để hệ thống tự động điền quy cách xe đã lưu';
      hint.className = 'text-xs text-slate-500 mt-1';
    }

    loadInYardTickets();
    loadDashboardStats();

    showTicketModal(data);

  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>✅</span><span>XÁC NHẬN XE VÀO CỔNG</span>';
    }
  }
}
const submitCheckIn = handleCheckIn;

// ============================================================================
// 10. GIÁM SÁT XE TRONG BÃI & XÁC NHẬN RA (CHECK-OUT)
// ============================================================================
async function loadInYardTickets(showLoading = true) {
  const container = document.getElementById('inYardContainer');
  if (showLoading && container) {
    container.innerHTML = '<div class="py-8 text-center text-slate-400 text-xs">Đang tải dữ liệu xe trong bãi...</div>';
  }

  try {
    let url = '/api/tickets/in-yard';
    if (AppState.selectedProjectId) {
      url += `?projectId=${AppState.selectedProjectId}`;
    }
    const res = await apiFetch(url);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    const tickets = await res.json();
    AppState.inYardTickets = tickets;

    const count = tickets.length;
    const headerInYard = document.getElementById('headerInYardCount');
    if (headerInYard) headerInYard.textContent = count;

    const navInYard = document.getElementById('navInYardBadge');
    if (navInYard) navInYard.textContent = count;

    const titleCount = document.getElementById('inYardTitleCount');
    if (titleCount) titleCount.textContent = `${count} xe`;

    const dashInYard = document.getElementById('dashInYard');
    if (dashInYard) dashInYard.textContent = count;

    if (!container) return;

    if (tickets.length === 0) {
      container.innerHTML = `
        <div class="py-16 text-center text-slate-400">
          <span class="text-5xl block mb-3">🚛</span>
          <p class="font-medium text-slate-600">Hiện không có xe nào trong bãi</p>
          <p class="text-xs text-slate-400 mt-1">Khi xe làm thủ tục vào cổng, danh sách sẽ hiển thị tại đây</p>
        </div>
      `;
      return;
    }

    container.innerHTML = tickets.map((t) => {
      const dim = (t.length > 0 && t.width > 0 && t.height > 0)
        ? `${t.length}x${t.width}x${t.height}m`
        : 'Quy chuẩn';

      const adjustNotice = t.is_manual_adjusted
        ? `<div class="mt-1 text-[11px] text-amber-700 font-semibold bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
             ⚠️ Điều chỉnh: ${t.actual_volume} ${t.unit || 'm³'} (${escapeHtml(t.adjustment_reason || 'Khác quy chuẩn')})
           </div>`
        : '';

      return `
        <div class="p-3.5 bg-slate-50 hover:bg-blue-50/50 rounded-xl border border-slate-200 transition flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <span class="font-mono font-bold text-base text-slate-900">${t.plate_number}</span>
              <span class="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-blue-100 text-blue-800">
                ${formatShortTime(t.time_in)}
              </span>
            </div>

            <div class="text-xs space-y-1 text-slate-600">
              <div class="flex items-center space-x-1">
                <span class="text-slate-400">🏗️</span>
                <span class="font-semibold text-slate-800 truncate">${escapeHtml(t.project_name || 'Dự án')}</span>
              </div>
              <div class="flex items-center space-x-1">
                <span class="text-slate-400">🧱</span>
                <span class="font-bold text-blue-700">${escapeHtml(t.material_name)}</span>
                <span class="text-[11px] text-slate-500">(${escapeHtml(t.supplier_name)})</span>
              </div>
              <div class="flex items-center justify-between text-[11px] pt-1 border-t border-slate-200">
                <span>KT: ${dim}</span>
                <span class="font-bold text-slate-900 font-mono text-xs">
                  ${Number(t.actual_volume).toFixed(2)} ${t.unit || 'm³'}
                </span>
              </div>
            </div>

            ${adjustNotice}
          </div>

          <div class="mt-3 pt-2 border-t border-slate-200/80 flex items-center space-x-2">
            <button onclick="fetchAndShowTicket(${t.id})"
              class="px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg border border-slate-300 transition">
              🖨️ In Phiếu
            </button>
            <button onclick="openCheckOutModal(${t.id})"
              class="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-xs font-bold rounded-lg shadow-sm transition flex items-center justify-center space-x-1">
              <span>🏁</span>
              <span>Xác Nhận Ra Cổng</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('Lỗi nạp xe trong bãi:', err);
    if (container) {
      container.innerHTML = `<div class="py-8 text-center text-red-500 text-xs">Lỗi nạp danh sách xe trong bãi: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function openCheckOutModal(ticketId) {
  const t = AppState.inYardTickets.find(item => item.id === ticketId);
  if (!t) return;

  AppState.activeCheckoutTicket = t;

  const codeEl = document.getElementById('coutTicketCode');
  if (codeEl) codeEl.textContent = t.ticket_code;

  const projEl = document.getElementById('coutProject');
  if (projEl) projEl.textContent = t.project_name || '-';

  const plateEl = document.getElementById('coutPlate');
  if (plateEl) plateEl.textContent = t.plate_number;

  const suppEl = document.getElementById('coutSupplier');
  if (suppEl) suppEl.textContent = t.supplier_name;

  const matEl = document.getElementById('coutMaterial');
  if (matEl) matEl.textContent = t.material_name;

  const inEl = document.getElementById('coutTimeIn');
  if (inEl) inEl.textContent = t.time_in;

  const outEl = document.getElementById('coutTimeOut');
  if (outEl) outEl.value = getLocalDateTime();

  const volEl = document.getElementById('coutActualVolume');
  if (volEl) volEl.value = t.actual_volume;

  const unitBadge = document.getElementById('coutUnitBadge');
  if (unitBadge) unitBadge.textContent = t.unit || 'm³';

  const reasonEl = document.getElementById('coutAdjustmentReason');
  if (reasonEl) reasonEl.value = t.adjustment_reason || '';

  const notesEl = document.getElementById('coutNotes');
  if (notesEl) notesEl.value = '';

  const modal = document.getElementById('checkOutModal');
  if (modal) modal.classList.remove('hidden');
}

function closeCheckOutModal() {
  AppState.activeCheckoutTicket = null;
  const modal = document.getElementById('checkOutModal');
  if (modal) modal.classList.add('hidden');
}

async function submitCheckOut() {
  if (!AppState.activeCheckoutTicket) return;

  const id = AppState.activeCheckoutTicket.id;
  const timeOut = (document.getElementById('coutTimeOut')?.value || '').trim();
  const actualVolume = parseFloat(document.getElementById('coutActualVolume')?.value);
  const adjustmentReason = (document.getElementById('coutAdjustmentReason')?.value || '').trim();
  const notes = (document.getElementById('coutNotes')?.value || '').trim();
  const unit = AppState.activeCheckoutTicket.unit || 'm³';

  if (isNaN(actualVolume) || actualVolume <= 0) {
    showToast(`Khối lượng thực nhận phải lớn hơn 0 ${unit}`, 'error');
    return;
  }

  try {
    const res = await apiFetch(`/api/tickets/${id}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        time_out: timeOut,
        actual_volume: actualVolume,
        adjustment_reason: adjustmentReason,
        notes
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi khi xác nhận ra');

    closeCheckOutModal();
    showToast(`✓ Xe ${data.plate_number} đã ra cổng hoàn tất (${data.actual_volume} ${data.unit})`, 'success');

    loadInYardTickets();
    loadDashboardStats();

    showTicketModal(data);

  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================================
// 11. DASHBOARD & BIỂU ĐỒ (CHARTS)
// ============================================================================
async function loadDashboardStats() {
  try {
    let url = '/api/dashboard';
    if (AppState.selectedProjectId) {
      url += `?projectId=${AppState.selectedProjectId}`;
    }
    const res = await apiFetch(url);
    if (!res.ok) return;

    const data = await res.json();
    const stats = data.stats || {};

    const dashTrips = document.getElementById('dashTotalTrips');
    if (dashTrips) dashTrips.textContent = stats.total_trips || 0;

    const dashInYard = document.getElementById('dashInYard');
    if (dashInYard) dashInYard.textContent = stats.in_yard_count || 0;

    const dashSupp = document.getElementById('dashActiveSuppliers');
    if (dashSupp) dashSupp.textContent = stats.active_suppliers || 0;

    // Hiển thị sản lượng theo từng ĐVT (m³, Tấn, m...)
    const volBox = document.getElementById('dashVolumeByUnitBox');
    if (volBox) {
      if (!data.volumeByUnit || data.volumeByUnit.length === 0) {
        volBox.innerHTML = `<div class="text-slate-400">0 phát sinh</div>`;
      } else {
        volBox.innerHTML = data.volumeByUnit.map(v => `
          <div class="flex justify-between items-center bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
            <span class="text-blue-900 font-semibold">${v.total_volume}</span>
            <span class="text-xs text-blue-700">${v.unit}</span>
          </div>
        `).join('');
      }
    }

    // Bảng cơ cấu vật liệu nhập hôm nay
    const matTbody = document.getElementById('dashMaterialBreakdownTable');
    if (matTbody) {
      if (!data.materialBreakdown || data.materialBreakdown.length === 0) {
        matTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-slate-400">Chưa có vật liệu nhập hôm nay</td></tr>`;
      } else {
        matTbody.innerHTML = data.materialBreakdown.map(m => `
          <tr class="hover:bg-slate-50 transition">
            <td class="px-3 py-2 font-medium text-slate-800">${escapeHtml(m.material_name)}</td>
            <td class="px-3 py-2 text-center font-bold text-blue-700">${escapeHtml(m.unit || 'm³')}</td>
            <td class="px-3 py-2 text-center font-mono">${m.trips}</td>
            <td class="px-3 py-2 text-right font-mono font-bold text-emerald-700">${Number(m.volume).toFixed(2)}</td>
          </tr>
        `).join('');
      }
    }

    // Biểu đồ lưu lượng xe theo giờ
    renderHourlyChart(data.hourlyDistribution || data.hourly || []);

  } catch (err) {
    console.error('Lỗi tải thống kê dashboard:', err);
  }
}

function renderHourlyChart(hourlyData) {
  const canvas = document.getElementById('hourlyChart') || document.getElementById('hourlyTrafficChart');
  if (!canvas) return;

  const labels = [];
  const counts = [];
  for (let h = 5; h <= 20; h++) {
    const pad = String(h).padStart(2, '0');
    labels.push(`${pad}:00`);
    const found = hourlyData.find(d => parseInt(d.hour, 10) === h);
    counts.push(found ? (found.trips || found.count || 0) : 0);
  }

  if (AppState.hourlyChart) {
    AppState.hourlyChart.destroy();
  }

  if (typeof Chart === 'undefined') return;

  const ctx = canvas.getContext('2d');
  AppState.hourlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Lượt xe vào cổng',
        data: counts,
        backgroundColor: 'rgba(37, 99, 235, 0.7)',
        borderColor: 'rgb(37, 99, 235)',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 }
        }
      }
    }
  });
}

// ============================================================================
// 12. NHẬT TRÌNH NGÀY, ĐIỀU CHỈNH PHIẾU & KHÓA SỐ LIỆU QUA NGÀY (TIME-LOCK)
// ============================================================================
function handleDailyFilterChange() {
  loadDailyReport();
}

async function loadDailyReport() {
  const dateInput = document.getElementById('dailyReportDate');
  const date = dateInput ? dateInput.value : getTodayDateStr();
  const projSel = document.getElementById('dailyProjectFilter');
  const projectId = projSel ? projSel.value : AppState.selectedProjectId;

  let url = `/api/reports/daily?date=${date}`;
  if (projectId) url += `&projectId=${projectId}`;

  // Kiểm tra quy tắc khóa số liệu: nếu người dùng là SITE_USER và xem ngày cũ -> Hiện thông báo khóa sổ
  const isSiteUser = AppState.currentUser && AppState.currentUser.role === 'SITE_USER';
  const isPastDate = date !== getTodayDateStr();
  const lockNotice = document.getElementById('dailyLockNotice');
  if (lockNotice) {
    if (isSiteUser && isPastDate) {
      lockNotice.classList.remove('hidden');
    } else {
      lockNotice.classList.add('hidden');
    }
  }

  try {
    const res = await apiFetch(url);
    const data = await res.json();
    AppState.dailyTickets = data.tickets || [];

    const summary = data.summary || {};

    const elTotal = document.getElementById('dailyTotalTrips');
    if (elTotal) elTotal.textContent = summary.total_trips || 0;

    const elProj = document.getElementById('dailyProjectsCount');
    if (elProj) elProj.textContent = summary.total_projects || 0;

    const elSupp = document.getElementById('dailySuppliersCount');
    if (elSupp) elSupp.textContent = summary.total_suppliers || 0;

    const elVeh = document.getElementById('dailyVehiclesCount');
    if (elVeh) elVeh.textContent = summary.total_vehicles || 0;

    const elRec = document.getElementById('dailyTableRecordCount');
    if (elRec) elRec.textContent = `${AppState.dailyTickets.length} chuyến xe`;

    // Bảng theo Vật liệu & ĐVT
    const matTbody = document.getElementById('dailyByMaterialTable');
    if (matTbody) {
      matTbody.innerHTML = (data.byMaterial || []).map(m => `
        <tr>
          <td class="px-2 py-1.5 font-medium text-slate-800">${escapeHtml(m.material_name)}</td>
          <td class="px-2 py-1.5 text-center font-bold text-blue-700">${escapeHtml(m.unit || 'm³')}</td>
          <td class="px-2 py-1.5 text-center font-mono">${m.trips}</td>
          <td class="px-2 py-1.5 text-right font-mono font-bold text-emerald-700">${Number(m.volume).toFixed(2)}</td>
        </tr>
      `).join('') || `<tr><td colspan="4" class="text-center py-2 text-slate-400">Không có dữ liệu</td></tr>`;
    }

    // Bảng theo Dự án
    const projTbody = document.getElementById('dailyByProjectTable');
    if (projTbody) {
      projTbody.innerHTML = (data.byProject || []).map(p => `
        <tr>
          <td class="px-2 py-1.5 font-medium text-slate-800">${escapeHtml(p.project_name || 'Dự án')}</td>
          <td class="px-2 py-1.5 text-center font-mono font-bold">${p.trips}</td>
        </tr>
      `).join('') || `<tr><td colspan="2" class="text-center py-2 text-slate-400">Không có dữ liệu</td></tr>`;
    }

    // Bảng kê chi tiết từng lượt xe
    const ticketsTbody = document.getElementById('dailyTicketsTableBody');
    if (ticketsTbody) {
      if (AppState.dailyTickets.length === 0) {
        ticketsTbody.innerHTML = `<tr><td colspan="14" class="text-center py-10 text-slate-400 font-medium">Không có lượt xe nào ghi nhận trong ngày ${date}</td></tr>`;
        return;
      }

      ticketsTbody.innerHTML = AppState.dailyTickets.map((t, index) => {
        const adjustBadge = t.is_manual_adjusted
          ? `<span class="text-amber-700 font-semibold" title="${escapeHtml(t.adjustment_reason || '')}">⚠️ ${escapeHtml(t.adjustment_reason || 'Điều chỉnh')}</span>`
          : `<span class="text-slate-400">Chuẩn</span>`;

        const statusBadge = t.status === 'IN_YARD'
          ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800">Trong bãi</span>`
          : (t.status === 'COMPLETED'
            ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-slate-100 text-slate-700">Đã xong</span>`
            : `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-red-100 text-red-700">Hủy</span>`);

        const ticketDate = (t.time_in || '').split(' ')[0];
        const isTicketToday = ticketDate === getTodayDateStr();
        const isAdmin = AppState.currentUser && AppState.currentUser.role === 'ADMIN';
        const canEdit = isAdmin || (isSiteUser && isTicketToday);

        let actionHtml = `<button onclick="fetchAndShowTicket(${t.id})" class="text-blue-600 hover:underline font-semibold" title="In phiếu">🖨️ In</button>`;

        if (t.status !== 'CANCELLED') {
          if (canEdit) {
            actionHtml += ` <button onclick="openEditTicketModalById(${t.id})" class="text-amber-600 hover:underline font-semibold ml-2" title="Điều chỉnh thông tin phiếu">✏️ Sửa</button>`;
          } else if (isSiteUser && !isTicketToday) {
            actionHtml += ` <span class="text-slate-400 ml-2" title="Số liệu đã khóa sổ qua ngày. Chỉ Admin mới có quyền điều chỉnh!">🔒 Khóa</span>`;
          }
        }

        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="px-3 py-2.5 text-center font-mono text-slate-500">${index + 1}</td>
            <td class="px-3 py-2.5 font-mono font-medium text-slate-700">${t.ticket_code}</td>
            <td class="px-3 py-2.5 font-medium text-slate-800 text-xs">${escapeHtml(t.project_name || '-')}</td>
            <td class="px-3 py-2.5 font-mono font-bold text-slate-900">${t.plate_number}</td>
            <td class="px-3 py-2.5 font-medium text-slate-800">${escapeHtml(t.supplier_name)}</td>
            <td class="px-3 py-2.5 text-slate-700">${escapeHtml(t.material_name)}</td>
            <td class="px-3 py-2.5 text-center font-bold text-blue-700">${escapeHtml(t.unit || 'm³')}</td>
            <td class="px-3 py-2.5 text-center font-mono text-slate-600">${formatShortTime(t.time_in)}</td>
            <td class="px-3 py-2.5 text-center font-mono text-slate-600">${formatShortTime(t.time_out)}</td>
            <td class="px-3 py-2.5 text-right font-mono text-slate-600">${Number(t.standard_volume).toFixed(2)}</td>
            <td class="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">${Number(t.actual_volume).toFixed(2)}</td>
            <td class="px-3 py-2.5 text-xs">${adjustBadge}</td>
            <td class="px-3 py-2.5 text-center">${statusBadge}</td>
            <td class="px-3 py-2.5 text-center no-print whitespace-nowrap">
              ${actionHtml}
            </td>
          </tr>
        `;
      }).join('');
    }

  } catch (err) {
    console.error('Lỗi nạp báo cáo ngày:', err);
    showToast('Lỗi khi tải dữ liệu báo cáo ngày', 'error');
  }
}

// Modal Điều Chỉnh Phiếu
function openEditTicketModalById(id) {
  const ticket = AppState.dailyTickets.find(t => t.id === id);
  if (!ticket) return;

  const idIn = document.getElementById('edit_ticket_id');
  if (idIn) idIn.value = ticket.id;

  const codeLabel = document.getElementById('edit_code_label');
  if (codeLabel) codeLabel.textContent = ticket.ticket_code;

  const timeLabel = document.getElementById('edit_time_label');
  if (timeLabel) timeLabel.textContent = `${ticket.time_in} (Dự án: ${ticket.project_name || '-'})`;

  const plateIn = document.getElementById('edit_plate');
  if (plateIn) plateIn.value = ticket.plate_number;

  const volIn = document.getElementById('edit_actual_volume');
  if (volIn) volIn.value = ticket.actual_volume;

  const reasonIn = document.getElementById('edit_adjust_reason');
  if (reasonIn) reasonIn.value = ticket.adjustment_reason || '';

  const notesIn = document.getElementById('edit_notes');
  if (notesIn) notesIn.value = ticket.notes || '';

  const modal = document.getElementById('editTicketModal');
  if (modal) modal.classList.remove('hidden');
}

function closeEditTicketModal() {
  const modal = document.getElementById('editTicketModal');
  if (modal) modal.classList.add('hidden');
}

async function saveEditTicket(e) {
  if (e && e.preventDefault) e.preventDefault();
  const id = document.getElementById('edit_ticket_id')?.value;
  const plate_number = (document.getElementById('edit_plate')?.value || '').trim().toUpperCase();
  const actual_volume = parseFloat(document.getElementById('edit_actual_volume')?.value);
  const adjustment_reason = (document.getElementById('edit_adjust_reason')?.value || '').trim();
  const notes = (document.getElementById('edit_notes')?.value || '').trim();

  if (!plate_number) {
    showToast('Biển số xe không được để trống', 'error');
    return;
  }
  if (isNaN(actual_volume) || actual_volume <= 0) {
    showToast('Khối lượng nghiệm thu phải lớn hơn 0', 'error');
    return;
  }

  try {
    const res = await apiFetch(`/api/tickets/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plate_number,
        actual_volume,
        adjustment_reason,
        notes,
        is_manual_adjusted: 1
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lỗi khi cập nhật phiếu');
    }

    closeEditTicketModal();
    showToast(`✓ Đã cập nhật phiếu xe ${data.plate_number} (${data.actual_volume} ${data.unit || 'm³'})`, 'success');
    loadDailyReport();
    loadInYardTickets();
    loadDashboardStats();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

function printDailyReport() {
  window.print();
}

function exportDailyExcel() {
  const dateInput = document.getElementById('dailyReportDate');
  const date = dateInput ? dateInput.value : getTodayDateStr();
  const projSel = document.getElementById('dailyProjectFilter');
  const projectId = projSel ? projSel.value : AppState.selectedProjectId;

  let url = `/api/reports/export-excel?type=daily&date=${date}`;
  if (projectId) url += `&projectId=${projectId}`;
  if (AppState.token) url += `&token=${encodeURIComponent(AppState.token)}`;
  window.location.href = url;
}

// ============================================================================
// 13. BÁO CÁO LŨY KẾ & XUẤT FILE EXCEL
// ============================================================================
function handleCumulativeFilterChange() {
  loadCumulativeReport();
}

async function loadCumulativeReport() {
  const startDate = document.getElementById('cumStartDate')?.value || getTodayDateStr();
  const endDate = document.getElementById('cumEndDate')?.value || getTodayDateStr();
  const projSel = document.getElementById('cumProjectFilter');
  const projectId = projSel ? projSel.value : AppState.selectedProjectId;
  const supplierId = document.getElementById('cumSupplierFilter')?.value || '';
  const materialId = document.getElementById('cumMaterialFilter')?.value || '';

  let url = `/api/reports/cumulative?startDate=${startDate}&endDate=${endDate}`;
  if (projectId) url += `&projectId=${projectId}`;
  if (supplierId) url += `&supplierId=${supplierId}`;
  if (materialId) url += `&materialId=${materialId}`;

  try {
    const res = await apiFetch(url);
    const data = await res.json();

    const summary = data.summary || {};

    const elTrips = document.getElementById('cumTotalTrips');
    if (elTrips) elTrips.textContent = summary.cumulative_trips || 0;

    const elProj = document.getElementById('cumProjectCount');
    if (elProj) elProj.textContent = summary.project_count || 0;

    const elSupp = document.getElementById('cumSupplierCount');
    if (elSupp) elSupp.textContent = summary.supplier_count || 0;

    const elDays = document.getElementById('cumActiveDays');
    if (elDays) elDays.textContent = summary.active_days || 0;

    // Bảng 1: Lũy kế theo Loại Vật Liệu & ĐVT
    const matTbody = document.getElementById('cumMaterialTableBody');
    if (matTbody) {
      if (!data.byMaterial || data.byMaterial.length === 0) {
        matTbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-400">Không có dữ liệu vật liệu trong giai đoạn</td></tr>`;
      } else {
        matTbody.innerHTML = data.byMaterial.map((m, idx) => `
          <tr class="hover:bg-slate-50 transition">
            <td class="px-4 py-3 text-center font-mono text-slate-500">${idx + 1}</td>
            <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(m.material_name)}</td>
            <td class="px-4 py-3 text-center font-bold text-blue-700 bg-blue-50/50">${escapeHtml(m.unit || 'm³')}</td>
            <td class="px-4 py-3 text-center font-mono font-semibold">${m.trips}</td>
            <td class="px-4 py-3 text-center font-mono">${m.vehicle_count || 0}</td>
            <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700 text-sm">${Number(m.volume).toFixed(2)} ${m.unit || 'm³'}</td>
          </tr>
        `).join('');
      }
    }

    // Bảng 2: Lũy kế theo Dự Án / Công Trường
    const projTbody = document.getElementById('cumProjectTableBody');
    if (projTbody) {
      if (!data.byProject || data.byProject.length === 0) {
        projTbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 text-slate-400">Không có dữ liệu dự án</td></tr>`;
      } else {
        projTbody.innerHTML = data.byProject.map((p, idx) => `
          <tr class="hover:bg-slate-50 transition">
            <td class="px-4 py-3 text-center font-mono text-slate-500">${idx + 1}</td>
            <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(p.project_name || 'Dự án')}</td>
            <td class="px-4 py-3 text-center font-mono font-semibold">${p.trips}</td>
            <td class="px-4 py-3 text-center font-mono">${p.supplier_count || 0}</td>
            <td class="px-4 py-3 text-center font-mono">${p.vehicle_count || 0}</td>
          </tr>
        `).join('');
      }
    }

    // Bảng 3: Chi tiết Nhà cung cấp & Vật liệu
    const suppTbody = document.getElementById('cumSupplierBreakdownTableBody');
    if (suppTbody) {
      if (!data.supplierMaterialBreakdown || data.supplierMaterialBreakdown.length === 0) {
        suppTbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-400">Không có dữ liệu nhà cung cấp</td></tr>`;
      } else {
        suppTbody.innerHTML = data.supplierMaterialBreakdown.map((s, idx) => `
          <tr class="hover:bg-slate-50 transition">
            <td class="px-4 py-3 text-center font-mono text-slate-500">${idx + 1}</td>
            <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(s.supplier_name)}</td>
            <td class="px-4 py-3 text-slate-800">${escapeHtml(s.material_name)}</td>
            <td class="px-4 py-3 text-center font-bold text-blue-700">${escapeHtml(s.unit || 'm³')}</td>
            <td class="px-4 py-3 text-center font-mono font-semibold">${s.trips}</td>
            <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700">${Number(s.volume).toFixed(2)} ${s.unit || 'm³'}</td>
          </tr>
        `).join('');
      }
    }

  } catch (err) {
    console.error('Lỗi tải báo cáo lũy kế:', err);
    showToast('Lỗi khi tải dữ liệu báo cáo lũy kế', 'error');
  }
}

function exportCumulativeExcel() {
  const startDate = document.getElementById('cumStartDate')?.value || getTodayDateStr();
  const endDate = document.getElementById('cumEndDate')?.value || getTodayDateStr();
  const projSel = document.getElementById('cumProjectFilter');
  const projectId = projSel ? projSel.value : AppState.selectedProjectId;

  let url = `/api/reports/export-excel?type=cumulative&startDate=${startDate}&endDate=${endDate}`;
  if (projectId) url += `&projectId=${projectId}`;
  if (AppState.token) url += `&token=${encodeURIComponent(AppState.token)}`;
  window.location.href = url;
}

// ============================================================================
// 14. IN PHIẾU KIỂM ĐẾM / XUẤT NHẬP (RECEIPT PRINT)
// ============================================================================
async function fetchAndShowTicket(ticketId) {
  try {
    const res = await apiFetch(`/api/tickets?search=${ticketId}`);
    const tickets = await res.json();
    const t = tickets.find(item => item.id === ticketId);
    if (t) {
      showTicketModal(t);
    }
  } catch (err) {
    console.error('Lỗi nạp phiếu:', err);
  }
}

function showTicketModal(ticket) {
  const codeEl = document.getElementById('prtTicketCode');
  if (codeEl) codeEl.textContent = ticket.ticket_code;

  const projEl = document.getElementById('prtProjectName');
  if (projEl) projEl.textContent = ticket.project_name || 'DỰ ÁN CÔNG TRÌNH';

  const plateEl = document.getElementById('prtPlate');
  if (plateEl) plateEl.textContent = ticket.plate_number;

  const suppEl = document.getElementById('prtSupplier');
  if (suppEl) suppEl.textContent = ticket.supplier_name;

  const matEl = document.getElementById('prtMaterial');
  if (matEl) matEl.textContent = ticket.material_name;

  const dim = (ticket.length > 0 && ticket.width > 0 && ticket.height > 0)
    ? `${ticket.length} x ${ticket.width} x ${ticket.height} m`
    : 'Theo quy chuẩn xe';
  const dimEl = document.getElementById('prtDimensions');
  if (dimEl) dimEl.textContent = dim;

  const unit = ticket.unit || 'm³';
  const stdEl = document.getElementById('prtStdVolume');
  if (stdEl) stdEl.textContent = `${Number(ticket.standard_volume).toFixed(2)} ${unit}`;

  const actEl = document.getElementById('prtActualVolume');
  if (actEl) actEl.textContent = `${Number(ticket.actual_volume).toFixed(2)} ${unit}`;

  const adjRow = document.getElementById('prtAdjustRow');
  const adjReason = document.getElementById('prtAdjustReason');
  if (ticket.is_manual_adjusted) {
    if (adjRow) adjRow.classList.remove('hidden');
    if (adjReason) adjReason.textContent = ticket.adjustment_reason || 'Điều chỉnh thủ công';
  } else {
    if (adjRow) adjRow.classList.add('hidden');
  }

  const inEl = document.getElementById('prtTimeIn');
  if (inEl) inEl.textContent = ticket.time_in;

  const outEl = document.getElementById('prtTimeOut');
  if (outEl) outEl.textContent = ticket.time_out || '(Đang dỡ hàng tại bãi)';

  const notesEl = document.getElementById('prtNotes');
  if (notesEl) notesEl.textContent = ticket.notes || 'Không';

  const modal = document.getElementById('ticketModal');
  if (modal) modal.classList.remove('hidden');
}

function closeTicketModal() {
  const modal = document.getElementById('ticketModal');
  if (modal) modal.classList.add('hidden');
}

// ============================================================================
// 15. CẤU HÌNH DANH MỤC & QUẢN LÝ TÀI KHOẢN (ADMIN ONLY)
// ============================================================================
function switchSettingsSubTab(sub) {
  document.querySelectorAll('.settings-subtab').forEach(btn => {
    if (btn.dataset.subtab === sub) {
      btn.className = 'settings-subtab px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 text-white shadow-sm';
    } else {
      btn.className = 'settings-subtab px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-200';
    }
  });

  document.querySelectorAll('.settings-pane').forEach(p => p.classList.add('hidden'));
  const activePane = document.getElementById(`settings-${sub}`);
  if (activePane) activePane.classList.remove('hidden');

  if (sub === 'users') loadUsers();
  if (sub === 'projects') renderSettingsProjects();
  if (sub === 'vehicles') renderSettingsVehicles();
  if (sub === 'materials') renderSettingsMaterials();
  if (sub === 'suppliers') renderSettingsSuppliers();
}

// --- 15.1 Quản Lý Tài Khoản (Users & RBAC) ---
async function loadUsers() {
  const tbody = document.getElementById('settingsUsersTable');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-400">Đang tải danh sách tài khoản...</td></tr>`;

  try {
    const res = await apiFetch('/api/users');
    AppState.users = await res.json();
    renderSettingsUsers();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-red-500">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSettingsUsers() {
  const tbody = document.getElementById('settingsUsersTable');
  if (!tbody) return;

  if (AppState.users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-400">Chưa có tài khoản nào</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.users.map(u => {
    const isSelf = AppState.currentUser && AppState.currentUser.id === u.id;
    const roleLabel = u.role === 'ADMIN'
      ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-purple-100 text-purple-800">👑 Admin</span>`
      : `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-blue-100 text-blue-800">🚚 Công Trường</span>`;
    const statusLabel = u.status === 'ACTIVE'
      ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800">Hoạt động</span>`
      : `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-red-100 text-red-800">Bị khóa</span>`;

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="px-4 py-3 font-mono font-bold text-slate-800">${escapeHtml(u.username)}</td>
        <td class="px-4 py-3 font-semibold text-slate-900">${escapeHtml(u.full_name)}</td>
        <td class="px-4 py-3 text-center">${roleLabel}</td>
        <td class="px-4 py-3 text-slate-700">${escapeHtml(u.project_name || (u.role === 'ADMIN' ? 'Toàn quyền (Tất cả dự án)' : '-'))}</td>
        <td class="px-4 py-3 text-center">${statusLabel}</td>
        <td class="px-4 py-3 text-center space-x-2">
          <button onclick="editUser(${u.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
          ${isSelf ? '' : `<button onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')" class="text-red-600 hover:underline font-semibold">Xóa</button>`}
        </td>
      </tr>
    `;
  }).join('');
}

function openUserModal() {
  const form = document.getElementById('userForm');
  if (form) form.reset();

  const idIn = document.getElementById('usr_id');
  if (idIn) idIn.value = '';

  const uIn = document.getElementById('usr_username');
  if (uIn) uIn.disabled = false;

  const titleEl = document.getElementById('userModalTitle') || document.getElementById('usrModalTitle');
  if (titleEl) titleEl.textContent = 'Cấp Tài Khoản Người Dùng Mới';

  const reqSpan = document.getElementById('usrPwdRequired');
  if (reqSpan) reqSpan.classList.remove('hidden');

  const hintP = document.getElementById('usrPwdHint');
  if (hintP) hintP.classList.add('hidden');

  const pwdIn = document.getElementById('usr_password');
  if (pwdIn) pwdIn.setAttribute('required', 'required');

  handleUserRoleChange();

  const modal = document.getElementById('userModal');
  if (modal) modal.classList.remove('hidden');
}

function closeUserModal() {
  const modal = document.getElementById('userModal');
  if (modal) modal.classList.add('hidden');
}

function handleUserRoleChange() {
  const role = document.getElementById('usr_role')?.value || 'SITE_USER';
  const wrapper = document.getElementById('usrProjectWrapper');
  const projSelect = document.getElementById('usr_project');
  if (role === 'ADMIN') {
    if (wrapper) wrapper.classList.add('hidden');
    if (projSelect) projSelect.removeAttribute('required');
  } else {
    if (wrapper) wrapper.classList.remove('hidden');
    if (projSelect) projSelect.setAttribute('required', 'required');
  }
}

function editUser(id) {
  const u = AppState.users.find(item => item.id === id);
  if (!u) return;

  const idIn = document.getElementById('usr_id');
  if (idIn) idIn.value = u.id;

  const uIn = document.getElementById('usr_username');
  if (uIn) {
    uIn.value = u.username;
    uIn.disabled = true;
  }

  const pwdIn = document.getElementById('usr_password');
  if (pwdIn) {
    pwdIn.value = '';
    pwdIn.removeAttribute('required');
  }

  const reqSpan = document.getElementById('usrPwdRequired');
  if (reqSpan) reqSpan.classList.add('hidden');

  const hintP = document.getElementById('usrPwdHint');
  if (hintP) hintP.classList.remove('hidden');

  const nameIn = document.getElementById('usr_fullname');
  if (nameIn) nameIn.value = u.full_name;

  const roleIn = document.getElementById('usr_role');
  if (roleIn) roleIn.value = u.role;

  const statIn = document.getElementById('usr_status');
  if (statIn) statIn.value = u.status;

  const projIn = document.getElementById('usr_project');
  if (projIn) projIn.value = u.project_id || '';

  handleUserRoleChange();

  const titleEl = document.getElementById('userModalTitle') || document.getElementById('usrModalTitle');
  if (titleEl) titleEl.textContent = `Chỉnh Sửa Tài Khoản: ${u.username}`;

  const modal = document.getElementById('userModal');
  if (modal) modal.classList.remove('hidden');
}

async function saveUser(event) {
  if (event && event.preventDefault) event.preventDefault();
  const id = document.getElementById('usr_id')?.value;
  const username = (document.getElementById('usr_username')?.value || '').trim().toLowerCase();
  const password = document.getElementById('usr_password')?.value || '';
  const full_name = (document.getElementById('usr_fullname')?.value || '').trim();
  const role = document.getElementById('usr_role')?.value || 'SITE_USER';
  const status = document.getElementById('usr_status')?.value || 'ACTIVE';
  const project_id = document.getElementById('usr_project')?.value || '';

  if (role === 'SITE_USER' && !project_id) {
    showToast('Vui lòng chọn Dự án phân công cho tài khoản công trường', 'error');
    return;
  }

  const payload = {
    username,
    full_name,
    role,
    status,
    project_id: role === 'SITE_USER' ? parseInt(project_id, 10) : null
  };

  if (password) {
    payload.password = password;
  }

  try {
    const url = id ? `/api/users/${id}` : '/api/users';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi khi lưu tài khoản');

    closeUserModal();
    showToast(`✓ Đã lưu tài khoản ${data.username}`, 'success');
    await loadUsers();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteUser(id, username) {
  if (!confirm(`Bạn có chắc chắn muốn xóa tài khoản "${username}"?`)) return;

  try {
    const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi khi xóa tài khoản');

    showToast(`Đã xóa tài khoản ${username}`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- 15.2 Cấu hình Dự Án ---
function renderSettingsProjects() {
  const tbody = document.getElementById('settingsProjectsTable');
  if (!tbody) return;

  if (AppState.projects.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400">Chưa có dự án nào</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.projects.map(p => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-4 py-3 font-mono font-semibold text-slate-700">${p.code}</td>
      <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(p.name)}</td>
      <td class="px-4 py-3 text-slate-600">${escapeHtml(p.location || '-')}</td>
      <td class="px-4 py-3 text-center">
        <span class="px-2 py-0.5 text-[10px] font-bold rounded-full ${p.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}">
          ${p.status === 'ACTIVE' ? 'Đang thi công' : p.status}
        </span>
      </td>
      <td class="px-4 py-3 text-center font-mono font-semibold">${p.total_trips || 0}</td>
      <td class="px-4 py-3 text-slate-400 text-xs">${escapeHtml(p.notes || '')}</td>
      <td class="px-4 py-3 text-center space-x-2">
        <button onclick="editProject(${p.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
        <button onclick="deleteProject(${p.id}, '${escapeHtml(p.name)}')" class="text-red-600 hover:underline font-semibold">Xóa</button>
      </td>
    </tr>
  `).join('');
}

function openProjectModal() {
  const form = document.getElementById('projectForm');
  if (form) form.reset();
  const idIn = document.getElementById('proj_id');
  if (idIn) idIn.value = '';
  const title = document.getElementById('projectModalTitle');
  if (title) title.textContent = 'Thêm Dự Án / Công Trường Mới';
  const modal = document.getElementById('projectModal');
  if (modal) modal.classList.remove('hidden');
}

function closeProjectModal() {
  const modal = document.getElementById('projectModal');
  if (modal) modal.classList.add('hidden');
}

function editProject(id) {
  const p = AppState.projects.find(item => item.id === id);
  if (!p) return;

  const idIn = document.getElementById('proj_id');
  if (idIn) idIn.value = p.id;
  const nameIn = document.getElementById('proj_name');
  if (nameIn) nameIn.value = p.name;
  const codeIn = document.getElementById('proj_code');
  if (codeIn) codeIn.value = p.code;
  const locIn = document.getElementById('proj_location');
  if (locIn) locIn.value = p.location || '';
  const statIn = document.getElementById('proj_status');
  if (statIn) statIn.value = p.status || 'ACTIVE';
  const notesIn = document.getElementById('proj_notes');
  if (notesIn) notesIn.value = p.notes || '';

  const title = document.getElementById('projectModalTitle');
  if (title) title.textContent = `Chỉnh Sửa Dự Án: ${p.name}`;
  const modal = document.getElementById('projectModal');
  if (modal) modal.classList.remove('hidden');
}

async function saveProject(event) {
  if (event && event.preventDefault) event.preventDefault();
  const id = document.getElementById('proj_id')?.value;
  const name = (document.getElementById('proj_name')?.value || '').trim();
  const code = (document.getElementById('proj_code')?.value || '').trim();
  const location = (document.getElementById('proj_location')?.value || '').trim();
  const status = document.getElementById('proj_status')?.value || 'ACTIVE';
  const notes = (document.getElementById('proj_notes')?.value || '').trim();

  const payload = { name, code, location, status, notes };

  try {
    const url = id ? `/api/projects/${id}` : '/api/projects';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu dự án');

    closeProjectModal();
    showToast(`✓ Đã lưu dự án: ${data.name}`, 'success');
    await loadProjects();
    renderSettingsProjects();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteProject(id, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa dự án "${name}"?`)) return;

  try {
    const res = await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể xóa dự án');

    showToast(`Đã xóa dự án ${name}`, 'success');
    await loadProjects();
    renderSettingsProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- 15.3 Cấu hình Xe ---
function renderSettingsVehicles() {
  const tbody = document.getElementById('settingsVehiclesTable');
  if (!tbody) return;

  if (AppState.vehicles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-400">Chưa có xe nào trong danh mục</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.vehicles.map(v => {
    const dim = (v.length > 0 && v.width > 0 && v.height > 0)
      ? `${v.length} x ${v.width} x ${v.height}`
      : '-';

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="px-4 py-3 font-mono font-bold text-slate-900">${v.plate_number}</td>
        <td class="px-4 py-3 text-slate-600">${escapeHtml(v.model_type || '')}</td>
        <td class="px-4 py-3 font-semibold text-slate-800">${escapeHtml(v.supplier_name || 'Chưa gán')}</td>
        <td class="px-4 py-3 text-center font-mono text-slate-600">${dim}</td>
        <td class="px-4 py-3 text-right font-mono font-bold text-blue-700 text-sm">${Number(v.standard_volume).toFixed(2)}</td>
        <td class="px-4 py-3 text-center font-bold text-blue-800">${v.unit || 'm³'}</td>
        <td class="px-4 py-3 text-slate-600">${escapeHtml(v.default_material_name || '-')}</td>
        <td class="px-4 py-3 text-center space-x-2">
          <button onclick="editVehicle(${v.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
          <button onclick="deleteVehicle(${v.id}, '${v.plate_number}')" class="text-red-600 hover:underline font-semibold">Xóa</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openVehicleModal() {
  const form = document.getElementById('vehicleForm');
  if (form) form.reset();
  const idIn = document.getElementById('veh_id');
  if (idIn) idIn.value = '';
  const title = document.getElementById('vehicleModalTitle');
  if (title) title.textContent = 'Thêm Xe Vận Chuyển Mới';
  const geo = document.getElementById('vehGeoVol');
  if (geo) geo.textContent = 'Thể tích: 0.00 m³';
  const modal = document.getElementById('vehicleModal');
  if (modal) modal.classList.remove('hidden');
}

function closeVehicleModal() {
  const modal = document.getElementById('vehicleModal');
  if (modal) modal.classList.add('hidden');
}

function calcVehGeoVol() {
  const l = parseFloat(document.getElementById('veh_length')?.value) || 0;
  const w = parseFloat(document.getElementById('veh_width')?.value) || 0;
  const h = parseFloat(document.getElementById('veh_height')?.value) || 0;
  const vol = l * w * h;
  const geo = document.getElementById('vehGeoVol');
  if (geo) geo.textContent = `Thể tích: ${vol.toFixed(2)} m³`;

  const stdIn = document.getElementById('veh_std_volume');
  const unit = document.getElementById('veh_unit')?.value || 'm³';
  if (stdIn && !stdIn.value && vol > 0 && unit === 'm³') {
    stdIn.value = vol.toFixed(2);
  }
}

function handleVehMaterialChange() {
  const matId = document.getElementById('veh_material')?.value;
  const mat = AppState.materials.find(m => m.id == matId);
  if (mat && mat.unit) {
    const unitIn = document.getElementById('veh_unit');
    if (unitIn) unitIn.value = mat.unit;
  }
}

function editVehicle(id) {
  const v = AppState.vehicles.find(item => item.id === id);
  if (!v) return;

  const idIn = document.getElementById('veh_id');
  if (idIn) idIn.value = v.id;
  const plateIn = document.getElementById('veh_plate');
  if (plateIn) plateIn.value = v.plate_number;
  const modelIn = document.getElementById('veh_model');
  if (modelIn) modelIn.value = v.model_type || '';
  const suppIn = document.getElementById('veh_supplier');
  if (suppIn) suppIn.value = v.supplier_id || '';
  const projIn = document.getElementById('veh_project');
  if (projIn) projIn.value = v.project_id || '';
  const lIn = document.getElementById('veh_length');
  if (lIn) lIn.value = v.length || '';
  const wIn = document.getElementById('veh_width');
  if (wIn) wIn.value = v.width || '';
  const hIn = document.getElementById('veh_height');
  if (hIn) hIn.value = v.height || '';
  const stdIn = document.getElementById('veh_std_volume');
  if (stdIn) stdIn.value = v.standard_volume || '';
  const unitIn = document.getElementById('veh_unit');
  if (unitIn) unitIn.value = v.unit || 'm³';
  const matIn = document.getElementById('veh_material');
  if (matIn) matIn.value = v.default_material_id || '';
  const notesIn = document.getElementById('veh_notes');
  if (notesIn) notesIn.value = v.notes || '';

  calcVehGeoVol();
  const title = document.getElementById('vehicleModalTitle');
  if (title) title.textContent = `Chỉnh Sửa Xe ${v.plate_number}`;
  const modal = document.getElementById('vehicleModal');
  if (modal) modal.classList.remove('hidden');
}

async function saveVehicle(event) {
  if (event && event.preventDefault) event.preventDefault();
  const id = document.getElementById('veh_id')?.value;
  const plate = (document.getElementById('veh_plate')?.value || '').trim().toUpperCase();
  const model = (document.getElementById('veh_model')?.value || '').trim();
  const supplierId = document.getElementById('veh_supplier')?.value;
  const projectId = document.getElementById('veh_project')?.value;
  const length = parseFloat(document.getElementById('veh_length')?.value) || 0;
  const width = parseFloat(document.getElementById('veh_width')?.value) || 0;
  const height = parseFloat(document.getElementById('veh_height')?.value) || 0;
  const stdVolume = parseFloat(document.getElementById('veh_std_volume')?.value) || 0;
  const unit = document.getElementById('veh_unit')?.value || 'm³';
  const materialId = document.getElementById('veh_material')?.value;
  const notes = (document.getElementById('veh_notes')?.value || '').trim();

  const payload = {
    plate_number: plate,
    model_type: model,
    supplier_id: supplierId ? parseInt(supplierId, 10) : null,
    project_id: projectId ? parseInt(projectId, 10) : null,
    length, width, height,
    standard_volume: stdVolume,
    unit,
    default_material_id: materialId ? parseInt(materialId, 10) : null,
    notes
  };

  try {
    const url = id ? `/api/vehicles/${id}` : '/api/vehicles';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu xe');

    closeVehicleModal();
    showToast(`✓ Đã lưu xe: ${data.plate_number}`, 'success');
    await loadVehicles();
    renderSettingsVehicles();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteVehicle(id, plate) {
  if (!confirm(`Bạn có chắc chắn muốn xóa xe "${plate}"?`)) return;

  try {
    const res = await apiFetch(`/api/vehicles/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể xóa xe');

    showToast(`Đã xóa xe ${plate}`, 'success');
    await loadVehicles();
    renderSettingsVehicles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- 15.4 Cấu hình Loại Vật Liệu & ĐVT ---
function renderSettingsMaterials() {
  const tbody = document.getElementById('settingsMaterialsTable');
  if (!tbody) return;

  if (AppState.materials.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-slate-400">Chưa có loại vật liệu nào</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.materials.map(m => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-4 py-3 font-mono font-semibold text-slate-700">${m.code}</td>
      <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(m.name)}</td>
      <td class="px-4 py-3 text-center">
        <span class="px-2.5 py-1 text-xs font-bold rounded-lg bg-blue-100 text-blue-800 border border-blue-200">
          ${escapeHtml(m.unit || 'm³')}
        </span>
      </td>
      <td class="px-4 py-3 text-center font-mono font-semibold">${m.total_trips || 0}</td>
      <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700">${Number(m.cumulative_volume || 0).toFixed(2)}</td>
      <td class="px-4 py-3 text-center space-x-2">
        <button onclick="editMaterial(${m.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
        <button onclick="deleteMaterial(${m.id}, '${escapeHtml(m.name)}')" class="text-red-600 hover:underline font-semibold">Xóa</button>
      </td>
    </tr>
  `).join('');
}

function openMaterialModal() {
  const form = document.getElementById('materialForm');
  if (form) form.reset();
  const idIn = document.getElementById('mat_id');
  if (idIn) idIn.value = '';
  const title = document.getElementById('materialModalTitle');
  if (title) title.textContent = 'Thêm Loại Vật Liệu Mới';
  const modal = document.getElementById('materialModal');
  if (modal) modal.classList.remove('hidden');
}

function closeMaterialModal() {
  const modal = document.getElementById('materialModal');
  if (modal) modal.classList.add('hidden');
}

function editMaterial(id) {
  const m = AppState.materials.find(item => item.id === id);
  if (!m) return;

  const idIn = document.getElementById('mat_id');
  if (idIn) idIn.value = m.id;
  const nameIn = document.getElementById('mat_name');
  if (nameIn) nameIn.value = m.name;
  const codeIn = document.getElementById('mat_code');
  if (codeIn) codeIn.value = m.code;
  const unitIn = document.getElementById('mat_unit');
  if (unitIn) unitIn.value = m.unit || 'm³';
  const descIn = document.getElementById('mat_desc');
  if (descIn) descIn.value = m.description || '';

  const title = document.getElementById('materialModalTitle');
  if (title) title.textContent = `Chỉnh Sửa Vật Liệu: ${m.name}`;
  const modal = document.getElementById('materialModal');
  if (modal) modal.classList.remove('hidden');
}

async function saveMaterial(event) {
  if (event && event.preventDefault) event.preventDefault();
  const id = document.getElementById('mat_id')?.value;
  const name = (document.getElementById('mat_name')?.value || '').trim();
  const code = (document.getElementById('mat_code')?.value || '').trim();
  const unit = (document.getElementById('mat_unit')?.value || 'm³').trim();
  const description = (document.getElementById('mat_desc')?.value || '').trim();

  const payload = { name, code, unit, description };

  try {
    const url = id ? `/api/materials/${id}` : '/api/materials';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu vật liệu');

    closeMaterialModal();
    showToast(`✓ Đã lưu vật liệu: ${data.name} (${data.unit})`, 'success');
    await loadMaterials();
    renderSettingsMaterials();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteMaterial(id, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa loại vật liệu "${name}"?`)) return;

  try {
    const res = await apiFetch(`/api/materials/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể xóa loại vật liệu');

    showToast(`Đã xóa vật liệu ${name}`, 'success');
    await loadMaterials();
    renderSettingsMaterials();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- 15.5 Cấu hình Nhà Cung Cấp ---
function renderSettingsSuppliers() {
  const tbody = document.getElementById('settingsSuppliersTable');
  if (!tbody) return;

  if (AppState.suppliers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400">Chưa có nhà cung cấp nào</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.suppliers.map(s => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-4 py-3 font-mono font-semibold text-slate-700">${s.code}</td>
      <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(s.name)}</td>
      <td class="px-4 py-3 text-slate-600 font-mono">${escapeHtml(s.phone || '-')}</td>
      <td class="px-4 py-3 text-slate-700">${escapeHtml(s.contact_person || '-')}</td>
      <td class="px-4 py-3 text-center font-mono font-semibold">${s.total_trips || 0}</td>
      <td class="px-4 py-3 text-slate-400 text-xs">${escapeHtml(s.notes || '')}</td>
      <td class="px-4 py-3 text-center space-x-2">
        <button onclick="editSupplier(${s.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
        <button onclick="deleteSupplier(${s.id}, '${escapeHtml(s.name)}')" class="text-red-600 hover:underline font-semibold">Xóa</button>
      </td>
    </tr>
  `).join('');
}

function openSupplierModal() {
  const form = document.getElementById('supplierForm');
  if (form) form.reset();
  const idIn = document.getElementById('supp_id');
  if (idIn) idIn.value = '';
  const title = document.getElementById('supplierModalTitle');
  if (title) title.textContent = 'Thêm Nhà Cung Cấp Mới';
  const modal = document.getElementById('supplierModal');
  if (modal) modal.classList.remove('hidden');
}

function closeSupplierModal() {
  const modal = document.getElementById('supplierModal');
  if (modal) modal.classList.add('hidden');
}

function editSupplier(id) {
  const s = AppState.suppliers.find(item => item.id === id);
  if (!s) return;

  const idIn = document.getElementById('supp_id');
  if (idIn) idIn.value = s.id;
  const nameIn = document.getElementById('supp_name');
  if (nameIn) nameIn.value = s.name;
  const codeIn = document.getElementById('supp_code');
  if (codeIn) codeIn.value = s.code;
  const phoneIn = document.getElementById('supp_phone');
  if (phoneIn) phoneIn.value = s.phone || '';
  const contactIn = document.getElementById('supp_contact');
  if (contactIn) contactIn.value = s.contact_person || '';
  const notesIn = document.getElementById('supp_notes');
  if (notesIn) notesIn.value = s.notes || '';

  const title = document.getElementById('supplierModalTitle');
  if (title) title.textContent = `Chỉnh Sửa Nhà Cung Cấp: ${s.name}`;
  const modal = document.getElementById('supplierModal');
  if (modal) modal.classList.remove('hidden');
}

async function saveSupplier(event) {
  if (event && event.preventDefault) event.preventDefault();
  const id = document.getElementById('supp_id')?.value;
  const name = (document.getElementById('supp_name')?.value || '').trim();
  const code = (document.getElementById('supp_code')?.value || '').trim();
  const phone = (document.getElementById('supp_phone')?.value || '').trim();
  const contact = (document.getElementById('supp_contact')?.value || '').trim();
  const notes = (document.getElementById('supp_notes')?.value || '').trim();

  const payload = { name, code, phone, contact_person: contact, notes };

  try {
    const url = id ? `/api/suppliers/${id}` : '/api/suppliers';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu nhà cung cấp');

    closeSupplierModal();
    showToast(`✓ Đã lưu nhà cung cấp: ${data.name}`, 'success');
    await loadSuppliers();
    renderSettingsSuppliers();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSupplier(id, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa nhà cung cấp "${name}"?`)) return;

  try {
    const res = await apiFetch(`/api/suppliers/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể xóa nhà cung cấp');

    showToast(`Đã xóa nhà cung cấp ${name}`, 'success');
    await loadSuppliers();
    renderSettingsSuppliers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================================
// 16. TIỆN ÍCH HỖ TRỢ (TOAST & FORMATTERS)
// ============================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  const bg = type === 'success' ? 'bg-emerald-600' : (type === 'error' ? 'bg-red-600' : 'bg-slate-800');

  toast.className = `${bg} text-white px-4 py-3 rounded-xl shadow-xl text-xs font-semibold flex items-center space-x-2 transition-all transform duration-300 translate-y-2 pointer-events-auto`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : (type === 'error' ? '⚠️' : 'ℹ️')}</span>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-2');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getLocalDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatShortTime(dateTimeStr) {
  if (!dateTimeStr) return '-';
  const parts = dateTimeStr.split(' ');
  return parts.length > 1 ? parts[1].slice(0, 5) : dateTimeStr;
}

// Gán toàn cục các hàm gọi từ thuộc tính inline HTML
window.handleLogin = handleLogin;
window.quickFillLogin = quickFillLogin;
window.handleLogout = handleLogout;
window.switchTab = switchTab;
window.handleHeaderProjectChange = handleHeaderProjectChange;
window.handlePlateInput = handlePlateInput;
window.selectVehicleSuggestion = selectVehicleSuggestion;
window.handleCheckinMaterialChange = handleCheckinMaterialChange;
window.onMaterialChange = handleCheckinMaterialChange;
window.calculateGeoVolume = calculateGeoVolume;
window.calcGeoVolume = calculateGeoVolume;
window.syncStdVolumeToActual = syncStdVolumeToActual;
window.toggleManualAdjustment = toggleManualAdjustment;
window.handleCheckIn = handleCheckIn;
window.submitCheckIn = handleCheckIn;
window.loadInYardTickets = loadInYardTickets;
window.openCheckOutModal = openCheckOutModal;
window.closeCheckOutModal = closeCheckOutModal;
window.submitCheckOut = submitCheckOut;
window.handleDailyFilterChange = handleDailyFilterChange;
window.openEditTicketModalById = openEditTicketModalById;
window.closeEditTicketModal = closeEditTicketModal;
window.saveEditTicket = saveEditTicket;
window.printDailyReport = printDailyReport;
window.exportDailyExcel = exportDailyExcel;
window.handleCumulativeFilterChange = handleCumulativeFilterChange;
window.exportCumulativeExcel = exportCumulativeExcel;
window.fetchAndShowTicket = fetchAndShowTicket;
window.closeTicketModal = closeTicketModal;
window.switchSettingsSubTab = switchSettingsSubTab;
window.openUserModal = openUserModal;
window.closeUserModal = closeUserModal;
window.editUser = editUser;
window.saveUser = saveUser;
window.deleteUser = deleteUser;
window.handleUserRoleChange = handleUserRoleChange;
window.openProjectModal = openProjectModal;
window.closeProjectModal = closeProjectModal;
window.editProject = editProject;
window.saveProject = saveProject;
window.deleteProject = deleteProject;
window.openVehicleModal = openVehicleModal;
window.closeVehicleModal = closeVehicleModal;
window.calcVehGeoVol = calcVehGeoVol;
window.handleVehMaterialChange = handleVehMaterialChange;
window.editVehicle = editVehicle;
window.saveVehicle = saveVehicle;
window.deleteVehicle = deleteVehicle;
window.openMaterialModal = openMaterialModal;
window.closeMaterialModal = closeMaterialModal;
window.editMaterial = editMaterial;
window.saveMaterial = saveMaterial;
window.deleteMaterial = deleteMaterial;
window.openSupplierModal = openSupplierModal;
window.closeSupplierModal = closeSupplierModal;
window.editSupplier = editSupplier;
window.saveSupplier = saveSupplier;
window.deleteSupplier = deleteSupplier;
