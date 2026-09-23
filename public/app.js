// Logic tương tác Frontend cho Phần mềm Quản lý Kho Vật Liệu Công Trường
// Hỗ trợ Đa Dự Án (Multi-project) & Đa Đơn Vị Tính (Tấn, m dài, m³, cái, bao...)

const AppState = {
  currentTab: 'checkin',
  selectedProjectId: '', // Rỗng nghĩa là xem "Tất cả dự án"
  projects: [],
  suppliers: [],
  materials: [],
  vehicles: [],
  inYardTickets: [],
  activeCheckoutTicket: null,
  hourlyChart: null,
  plateDebounceTimer: null
};

// ============================================================================
// 1. KHỞI TẠO & ĐỒNG HỒ THỜI GIAN THỰC
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  initDates();
  loadInitialData();

  // Tự động làm mới xe trong bãi mỗi 20 giây
  setInterval(() => {
    if (AppState.currentTab === 'checkin' || AppState.currentTab === 'dashboard') {
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
// 2. QUẢN LÝ DỰ ÁN & BỘ CHỌN DỰ ÁN (PROJECT SWITCHER)
// ============================================================================
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    AppState.projects = await res.json();
    populateProjectDropdowns();
  } catch (err) {
    console.error('Lỗi tải danh mục dự án:', err);
  }
}

function populateProjectDropdowns() {
  const headerSel = document.getElementById('headerProjectSelect');
  const checkinSel = document.getElementById('checkin_project');
  const dailySel = document.getElementById('dailyProjectFilter');
  const cumSel = document.getElementById('cumProjectFilter');
  const vehSel = document.getElementById('veh_project');

  const optionsFilter = '<option value="">-- Tất cả dự án --</option>' +
    AppState.projects.map(p => `<option value="${p.id}" ${AppState.selectedProjectId == p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  const optionsRequired = '<option value="">-- Chọn dự án tiếp nhận --</option>' +
    AppState.projects.map(p => `<option value="${p.id}" ${AppState.selectedProjectId == p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  if (headerSel) headerSel.innerHTML = optionsFilter;
  if (dailySel) dailySel.innerHTML = optionsFilter;
  if (cumSel) cumSel.innerHTML = optionsFilter;
  if (vehSel) vehSel.innerHTML = '<option value="">-- Chọn dự án thường trực --</option>' + AppState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (checkinSel) checkinSel.innerHTML = optionsRequired;
}

function handleHeaderProjectChange() {
  const sel = document.getElementById('headerProjectSelect');
  AppState.selectedProjectId = sel ? sel.value : '';

  // Đồng bộ sang form checkin và bộ lọc báo cáo
  const checkinSel = document.getElementById('checkin_project');
  if (checkinSel && AppState.selectedProjectId) checkinSel.value = AppState.selectedProjectId;

  const dailySel = document.getElementById('dailyProjectFilter');
  if (dailySel) dailySel.value = AppState.selectedProjectId;

  const cumSel = document.getElementById('cumProjectFilter');
  if (cumSel) cumSel.value = AppState.selectedProjectId;

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
// 3. CHUYỂN TAB VÀ ĐIỀU HƯỚNG
// ============================================================================
function switchTab(tabId) {
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
    renderSettingsProjects();
  }
}

// ============================================================================
// 4. NẠP DANH MỤC CƠ BẢN (SUPPLIERS, MATERIALS, VEHICLES)
// ============================================================================
async function loadSuppliers() {
  try {
    const res = await fetch('/api/suppliers');
    AppState.suppliers = await res.json();
    populateSupplierDropdowns();
  } catch (err) {
    console.error('Lỗi tải danh sách nhà cung cấp:', err);
  }
}

function populateSupplierDropdowns() {
  const checkinSel = document.getElementById('checkin_supplier');
  const vehSel = document.getElementById('veh_supplier');
  const cumSel = document.getElementById('cumSupplierFilter');

  const optionsHtml = '<option value="">-- Chọn nhà cung cấp --</option>' +
    AppState.suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  if (checkinSel) checkinSel.innerHTML = optionsHtml;
  if (vehSel) vehSel.innerHTML = optionsHtml;

  if (cumSel) {
    cumSel.innerHTML = '<option value="">-- Tất cả nhà cung cấp --</option>' +
      AppState.suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  }
}

async function loadMaterials() {
  try {
    const res = await fetch('/api/materials');
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

  const optionsHtml = '<option value="">-- Chọn loại vật liệu --</option>' +
    AppState.materials.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (ĐVT: ${m.unit || 'm³'})</option>`).join('');

  if (checkinSel) checkinSel.innerHTML = optionsHtml;
  if (vehSel) vehSel.innerHTML = optionsHtml;

  if (cumSel) {
    cumSel.innerHTML = '<option value="">-- Tất cả vật liệu --</option>' +
      AppState.materials.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  }
}

async function loadVehicles() {
  try {
    const res = await fetch('/api/vehicles');
    AppState.vehicles = await res.json();
  } catch (err) {
    console.error('Lỗi tải danh mục xe:', err);
  }
}

// ============================================================================
// 5. LOGIC CHECK-IN & TỰ ĐỘNG ĐỔI ĐƠN VỊ TÍNH (TẤN, M DÀI, M³...)
// ============================================================================
function handleCheckinMaterialChange() {
  const matId = document.getElementById('checkin_material').value;
  const mat = AppState.materials.find(m => m.id == matId);
  const unit = mat ? (mat.unit || 'm³') : 'm³';

  // Cập nhật nhãn đơn vị tính trên các ô khối lượng
  const stdBadge = document.getElementById('checkinStdUnitBadge');
  const actBadge = document.getElementById('checkinActualUnitBadge');
  if (stdBadge) stdBadge.textContent = unit;
  if (actBadge) actBadge.textContent = unit;
}

function handlePlateInput(val) {
  clearTimeout(AppState.plateDebounceTimer);
  const cleanVal = val.trim().toUpperCase();

  const suggestionsBox = document.getElementById('plateSuggestions');
  const hintEl = document.getElementById('plateHint');

  if (!cleanVal) {
    suggestionsBox.classList.add('hidden');
    hintEl.textContent = 'Gõ biển số để hệ thống tự động điền quy cách xe đã lưu';
    return;
  }

  const matches = AppState.vehicles.filter(v => v.plate_number.toUpperCase().includes(cleanVal));

  if (matches.length > 0) {
    suggestionsBox.innerHTML = matches.map(v => `
      <div onclick="selectVehicleByPlate('${v.plate_number}')" 
        class="px-3.5 py-2 hover:bg-blue-50 cursor-pointer border-b border-slate-100 flex items-center justify-between">
        <div>
          <span class="font-mono font-bold text-blue-700">${v.plate_number}</span>
          <span class="text-xs text-slate-500 ml-2">(${v.model_type || 'Xe ben/tải'})</span>
        </div>
        <div class="text-right">
          <span class="text-xs font-bold text-slate-800">${v.standard_volume} ${v.unit || 'm³'}</span>
          <span class="text-[10px] text-slate-400 block">${escapeHtml(v.supplier_name || '')}</span>
        </div>
      </div>
    `).join('');
    suggestionsBox.classList.remove('hidden');
  } else {
    suggestionsBox.classList.add('hidden');
    hintEl.innerHTML = `<span class="text-amber-600 font-semibold">Xe mới chưa có trong danh mục.</span> Hệ thống sẽ tự động lưu quy cách khi bạn bấm Xác nhận vào!`;
  }
}

function selectVehicleByPlate(plate) {
  const v = AppState.vehicles.find(item => item.plate_number === plate);
  if (!v) return;

  document.getElementById('checkin_plate').value = v.plate_number;
  document.getElementById('checkin_model').value = v.model_type || '';
  if (v.project_id) document.getElementById('checkin_project').value = v.project_id;
  if (v.supplier_id) document.getElementById('checkin_supplier').value = v.supplier_id;
  if (v.default_material_id) {
    document.getElementById('checkin_material').value = v.default_material_id;
    handleCheckinMaterialChange();
  }

  document.getElementById('checkin_length').value = v.length || '';
  document.getElementById('checkin_width').value = v.width || '';
  document.getElementById('checkin_height').value = v.height || '';
  calculateGeoVolume();

  document.getElementById('checkin_std_volume').value = v.standard_volume || '';
  const unit = v.unit || 'm³';
  document.getElementById('checkinStdUnitBadge').textContent = unit;
  document.getElementById('checkinActualUnitBadge').textContent = unit;

  syncStdVolumeToActual();

  document.getElementById('plateSuggestions').classList.add('hidden');
  document.getElementById('plateHint').innerHTML = `
    <span class="text-emerald-700 font-semibold">✓ Đã nạp quy cách xe ${v.plate_number}:</span> 
    Định mức chuẩn <b class="text-blue-700">${v.standard_volume} ${unit}</b> (${v.supplier_name || 'NCC'})
  `;
}

function calculateGeoVolume() {
  const l = parseFloat(document.getElementById('checkin_length').value) || 0;
  const w = parseFloat(document.getElementById('checkin_width').value) || 0;
  const h = parseFloat(document.getElementById('checkin_height').value) || 0;

  const vol = l * w * h;
  const geoEl = document.getElementById('calculatedGeoVol');
  if (geoEl) {
    geoEl.textContent = `Thể tích: ${vol.toFixed(2)} m³`;
  }

  const matId = document.getElementById('checkin_material').value;
  const mat = AppState.materials.find(m => m.id == matId);
  const isCubic = !mat || mat.unit === 'm³';

  // Chỉ tự động gán sang khối lượng cố định nếu là vật liệu tính theo m³
  const stdInput = document.getElementById('checkin_std_volume');
  if (stdInput && !stdInput.value && vol > 0 && isCubic) {
    stdInput.value = vol.toFixed(2);
    syncStdVolumeToActual();
  }
}

function syncStdVolumeToActual() {
  const isManual = document.getElementById('checkin_manual_toggle').checked;
  const stdVol = parseFloat(document.getElementById('checkin_std_volume').value) || 0;

  if (!isManual) {
    document.getElementById('checkin_actual_volume').value = stdVol > 0 ? stdVol : '';
  }
}

function toggleManualAdjustment() {
  const isManual = document.getElementById('checkin_manual_toggle').checked;
  const box = document.getElementById('manualAdjustmentBox');
  const actualInput = document.getElementById('checkin_actual_volume');
  const stdVol = parseFloat(document.getElementById('checkin_std_volume').value) || 0;

  if (isManual) {
    box.classList.remove('hidden');
    if (!actualInput.value && stdVol > 0) {
      actualInput.value = stdVol;
    }
    actualInput.focus();
  } else {
    box.classList.add('hidden');
    actualInput.value = stdVol > 0 ? stdVol : '';
    document.getElementById('checkin_adjust_reason').value = '';
  }
}

async function handleCheckIn(event) {
  event.preventDefault();

  const projectId = document.getElementById('checkin_project').value;
  const plate = document.getElementById('checkin_plate').value.trim().toUpperCase();
  const model = document.getElementById('checkin_model').value.trim();
  const supplierId = document.getElementById('checkin_supplier').value;
  const materialId = document.getElementById('checkin_material').value;

  const length = parseFloat(document.getElementById('checkin_length').value) || 0;
  const width = parseFloat(document.getElementById('checkin_width').value) || 0;
  const height = parseFloat(document.getElementById('checkin_height').value) || 0;
  const stdVolume = parseFloat(document.getElementById('checkin_std_volume').value) || 0;

  const mat = AppState.materials.find(m => m.id == materialId);
  const unit = mat ? (mat.unit || 'm³') : 'm³';

  const isManual = document.getElementById('checkin_manual_toggle').checked;
  let actualVolume = stdVolume;
  let adjustReason = '';

  if (isManual) {
    actualVolume = parseFloat(document.getElementById('checkin_actual_volume').value) || 0;
    adjustReason = document.getElementById('checkin_adjust_reason').value.trim();
    if (actualVolume <= 0) {
      showToast(`Khối lượng nghiệm thu thủ công phải lớn hơn 0 ${unit}`, 'error');
      return;
    }
  }

  const notes = document.getElementById('checkin_notes').value.trim();

  const payload = {
    project_id: projectId ? parseInt(projectId, 10) : null,
    plate_number: plate,
    model_type: model,
    supplier_id: supplierId ? parseInt(supplierId, 10) : null,
    material_id: materialId ? parseInt(materialId, 10) : null,
    unit,
    length,
    width,
    height,
    standard_volume: stdVolume,
    actual_volume: actualVolume,
    is_manual_adjusted: isManual,
    adjustment_reason: adjustReason,
    notes
  };

  const btn = document.getElementById('btnSubmitCheckIn');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳ Đang ghi nhận...</span>';

  try {
    const res = await fetch('/api/tickets/checkin', {
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
    document.getElementById('checkInForm').reset();
    if (AppState.selectedProjectId) {
      document.getElementById('checkin_project').value = AppState.selectedProjectId;
    }
    document.getElementById('checkin_manual_toggle').checked = false;
    toggleManualAdjustment();
    document.getElementById('calculatedGeoVol').textContent = 'Thể tích: 0.00 m³';
    document.getElementById('plateHint').textContent = 'Gõ biển số để hệ thống tự động điền quy cách xe đã lưu';

    loadInYardTickets();
    loadDashboardStats();

    showTicketModal(data);

  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>✅</span><span>XÁC NHẬN XE VÀO CỔNG</span>';
  }
}

// ============================================================================
// 6. GIÁM SÁT XE TRONG BÃI & XÁC NHẬN RA (CHECK-OUT)
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
    const res = await fetch(url);
    const tickets = await res.json();
    AppState.inYardTickets = tickets;

    const count = tickets.length;
    document.getElementById('headerInYardCount').textContent = count;
    document.getElementById('navInYardBadge').textContent = count;
    document.getElementById('inYardTitleCount').textContent = `${count} xe`;
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
      const durationMin = calculateDurationMinutes(t.time_in);
      const unit = t.unit || 'm³';
      const adjustBadge = t.is_manual_adjusted
        ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-800 border border-amber-300">Vơi/Ngọn: ${t.actual_volume} ${unit}</span>`
        : `<span class="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-100 text-blue-800">Quy chuẩn: ${t.standard_volume} ${unit}</span>`;

      return `
        <div class="p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-400 shadow-sm transition flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="space-y-1">
            <div class="flex items-center space-x-2 flex-wrap gap-y-1">
              <span class="license-plate-badge text-sm">${t.plate_number}</span>
              <span class="text-xs font-bold text-slate-700">${escapeHtml(t.material_name)}</span>
              ${adjustBadge}
              <span class="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border">🏗️ ${escapeHtml(t.project_name || 'Dự án')}</span>
            </div>

            <div class="text-xs text-slate-600 font-medium">
              <span>🏢 ${escapeHtml(t.supplier_name)}</span>
            </div>

            <div class="flex items-center space-x-3 text-[11px] text-slate-500 font-mono">
              <span>⏰ Vào: <b>${formatShortTime(t.time_in)}</b></span>
              <span class="text-amber-700 font-sans font-semibold">⏳ Đã ở trong bãi: <b>${durationMin}</b></span>
            </div>

            ${t.notes ? `<div class="text-[11px] text-slate-400 italic">📝 ${escapeHtml(t.notes)}</div>` : ''}
          </div>

          <div class="flex items-center space-x-2 sm:flex-col sm:space-x-0 sm:space-y-2 justify-end">
            <button onclick="openCheckOutModal(${t.id})" 
              class="flex-1 sm:flex-none px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow transition flex items-center justify-center space-x-1">
              <span>🏁</span>
              <span>XÁC NHẬN RA</span>
            </button>
            <button onclick="fetchAndShowTicket(${t.id})" 
              class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-medium">
              In phiếu
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('Lỗi nạp xe trong bãi:', err);
  }
}

function calculateDurationMinutes(timeInStr) {
  const inTime = new Date(timeInStr.replace(' ', 'T'));
  const now = new Date();
  const diffMs = now - inTime;
  if (isNaN(diffMs) || diffMs < 0) return 'Vừa vào';

  const totalMin = Math.floor(diffMs / (1000 * 60));
  if (totalMin < 60) {
    return `${totalMin} phút`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h ${min}p`;
}

function formatShortTime(timeStr) {
  if (!timeStr) return '--:--';
  const parts = timeStr.split(' ');
  return parts.length > 1 ? parts[1].substring(0, 5) : timeStr;
}

function openCheckOutModal(ticketId) {
  const ticket = AppState.inYardTickets.find(t => t.id === ticketId);
  if (!ticket) return;

  AppState.activeCheckoutTicket = ticket;

  document.getElementById('coutTicketCode').textContent = ticket.ticket_code;
  document.getElementById('coutProject').textContent = ticket.project_name || 'Công trường';
  document.getElementById('coutPlate').textContent = ticket.plate_number;
  document.getElementById('coutSupplier').textContent = ticket.supplier_name;
  document.getElementById('coutMaterial').textContent = ticket.material_name;
  document.getElementById('coutTimeIn').textContent = ticket.time_in;

  const now = new Date();
  document.getElementById('coutTimeOut').value = getLocalDateTime(now);
  document.getElementById('coutActualVolume').value = ticket.actual_volume;
  document.getElementById('coutUnitBadge').textContent = ticket.unit || 'm³';
  document.getElementById('coutAdjustmentReason').value = ticket.adjustment_reason || '';
  document.getElementById('coutNotes').value = '';

  document.getElementById('checkOutModal').classList.remove('hidden');
}

function closeCheckOutModal() {
  document.getElementById('checkOutModal').classList.add('hidden');
  AppState.activeCheckoutTicket = null;
}

async function submitCheckOut() {
  if (!AppState.activeCheckoutTicket) return;
  const id = AppState.activeCheckoutTicket.id;
  const unit = AppState.activeCheckoutTicket.unit || 'm³';

  const timeOut = document.getElementById('coutTimeOut').value;
  const actualVolume = parseFloat(document.getElementById('coutActualVolume').value) || 0;
  const adjustmentReason = document.getElementById('coutAdjustmentReason').value.trim();
  const notes = document.getElementById('coutNotes').value.trim();

  if (actualVolume <= 0) {
    showToast(`Khối lượng thực nhận phải lớn hơn 0 ${unit}`, 'error');
    return;
  }

  try {
    const res = await fetch(`/api/tickets/${id}/checkout`, {
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
// 7. DASHBOARD & BIỂU ĐỒ (CHARTS)
// ============================================================================
async function loadDashboardStats() {
  try {
    let url = '/api/dashboard';
    if (AppState.selectedProjectId) {
      url += `?projectId=${AppState.selectedProjectId}`;
    }
    const res = await fetch(url);
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
        volBox.innerHTML = `<div>0 phát sinh</div>`;
      } else {
        volBox.innerHTML = data.volumeByUnit.map(v => `
          <div class="flex justify-between items-center bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
            <span class="text-blue-900 font-semibold">${v.total_volume}</span>
            <span class="text-xs text-blue-700">${v.unit}</span>
          </div>
        `).join('');
      }
    }

    renderDashboardMaterialBreakdown(data.materialBreakdown || []);
    renderDashboardRecent(data.recentTickets || []);
    renderHourlyChart(data.hourlyDistribution || []);

  } catch (err) {
    console.error('Lỗi tải thống kê dashboard:', err);
  }
}

function renderDashboardMaterialBreakdown(list) {
  const tbody = document.getElementById('dashMaterialBreakdownTable');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-slate-400">Chưa có chuyến nào hôm nay</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(item => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-3 py-2 font-medium text-slate-800">${escapeHtml(item.material_name)}</td>
      <td class="px-3 py-2 text-center font-bold text-blue-700">${escapeHtml(item.unit || 'm³')}</td>
      <td class="px-3 py-2 text-center font-mono font-semibold">${item.trips}</td>
      <td class="px-3 py-2 text-right font-mono font-bold text-emerald-700">${item.volume.toFixed(2)}</td>
    </tr>
  `).join('');
}

function renderDashboardRecent(tickets) {
  const tbody = document.getElementById('dashRecentTicketsTable');
  if (!tbody) return;

  if (tickets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-slate-400">Chưa có lượt xe nào</td></tr>`;
    return;
  }

  tbody.innerHTML = tickets.map(t => {
    const statusBadge = t.status === 'IN_YARD'
      ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800">Trong bãi</span>`
      : (t.status === 'COMPLETED'
        ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-slate-100 text-slate-700">Đã ra</span>`
        : `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-red-100 text-red-700">Hủy</span>`);

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="px-4 py-3 font-mono font-medium text-slate-600">${t.ticket_code}</td>
        <td class="px-4 py-3 font-semibold text-slate-800 text-xs">${escapeHtml(t.project_name || '-')}</td>
        <td class="px-4 py-3 font-mono font-bold text-slate-900">${t.plate_number}</td>
        <td class="px-4 py-3 text-slate-700 font-medium">${escapeHtml(t.supplier_name)}</td>
        <td class="px-4 py-3 text-slate-700">${escapeHtml(t.material_name)}</td>
        <td class="px-4 py-3 text-center font-bold text-blue-700">${escapeHtml(t.unit || 'm³')}</td>
        <td class="px-4 py-3 text-slate-500 font-mono">${formatShortTime(t.time_in)}</td>
        <td class="px-4 py-3 text-slate-500 font-mono">${formatShortTime(t.time_out)}</td>
        <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700">${t.actual_volume.toFixed(2)}</td>
        <td class="px-4 py-3 text-center">${statusBadge}</td>
      </tr>
    `;
  }).join('');
}

function renderHourlyChart(hourly) {
  const canvas = document.getElementById('hourlyChart');
  if (!canvas) return;

  if (AppState.hourlyChart) {
    AppState.hourlyChart.destroy();
  }

  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00');
  const tripsData = Array(24).fill(0);

  hourly.forEach(h => {
    const idx = parseInt(h.hour, 10);
    if (idx >= 0 && idx < 24) {
      tripsData[idx] = h.trips;
    }
  });

  const filteredHours = hours.slice(6, 20);
  const filteredTrips = tripsData.slice(6, 20);

  AppState.hourlyChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: filteredHours,
      datasets: [{
        label: 'Số chuyến xe vào',
        data: filteredTrips,
        backgroundColor: '#3b82f6',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// ============================================================================
// 8. BÁO CÁO NHẬT TRÌNH HÀNG NGÀY (DAILY REPORT)
// ============================================================================
function setDailyDateToday() {
  document.getElementById('dailyReportDate').value = getTodayDateStr();
  loadDailyReport();
}

async function loadDailyReport() {
  const dateInput = document.getElementById('dailyReportDate');
  const date = dateInput ? dateInput.value : getTodayDateStr();
  const projSel = document.getElementById('dailyProjectFilter');
  const projectId = projSel ? projSel.value : AppState.selectedProjectId;

  let url = `/api/reports/daily?date=${date}`;
  if (projectId) url += `&projectId=${projectId}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    const summary = data.summary || {};

    document.getElementById('dailyTotalTrips').textContent = summary.total_trips || 0;
    document.getElementById('dailyProjectsCount').textContent = summary.total_projects || 0;
    document.getElementById('dailySuppliersCount').textContent = summary.total_suppliers || 0;
    document.getElementById('dailyVehiclesCount').textContent = summary.total_vehicles || 0;

    document.getElementById('dailyTableRecordCount').textContent = `${data.tickets.length} chuyến xe`;

    // Bảng theo Vật liệu & ĐVT
    const matTbody = document.getElementById('dailyByMaterialTable');
    if (matTbody) {
      matTbody.innerHTML = (data.byMaterial || []).map(m => `
        <tr>
          <td class="px-2 py-1.5 font-medium text-slate-800">${escapeHtml(m.material_name)}</td>
          <td class="px-2 py-1.5 text-center font-bold text-blue-700">${escapeHtml(m.unit || 'm³')}</td>
          <td class="px-2 py-1.5 text-center font-mono">${m.trips}</td>
          <td class="px-2 py-1.5 text-right font-mono font-bold text-emerald-700">${m.volume.toFixed(2)}</td>
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

    // Bảng kê chi tiết
    const ticketsTbody = document.getElementById('dailyTicketsTableBody');
    if (ticketsTbody) {
      if (data.tickets.length === 0) {
        ticketsTbody.innerHTML = `<tr><td colspan="14" class="text-center py-10 text-slate-400 font-medium">Không có lượt xe nào ghi nhận trong ngày ${date}</td></tr>`;
        return;
      }

      ticketsTbody.innerHTML = data.tickets.map((t, index) => {
        const adjustBadge = t.is_manual_adjusted
          ? `<span class="text-amber-700 font-semibold" title="${escapeHtml(t.adjustment_reason || '')}">⚠️ ${escapeHtml(t.adjustment_reason || 'Điều chỉnh')}</span>`
          : `<span class="text-slate-400">Chuẩn</span>`;

        const statusBadge = t.status === 'IN_YARD'
          ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800">Trong bãi</span>`
          : (t.status === 'COMPLETED'
            ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-slate-100 text-slate-700">Đã xong</span>`
            : `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-red-100 text-red-700">Hủy</span>`);

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
            <td class="px-3 py-2.5 text-right font-mono text-slate-600">${t.standard_volume.toFixed(2)}</td>
            <td class="px-3 py-2.5 text-right font-mono font-bold text-emerald-700">${t.actual_volume.toFixed(2)}</td>
            <td class="px-3 py-2.5 text-xs">${adjustBadge}</td>
            <td class="px-3 py-2.5 text-center">${statusBadge}</td>
            <td class="px-3 py-2.5 text-center no-print">
              <button onclick="fetchAndShowTicket(${t.id})" class="text-blue-600 hover:underline font-semibold" title="In phiếu">🖨️ In</button>
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
  window.location.href = url;
}

// ============================================================================
// 9. BÁO CÁO KHỐI LƯỢNG LŨY KẾ (CUMULATIVE REPORT)
// ============================================================================
function setCumPreset(preset) {
  const startInput = document.getElementById('cumStartDate');
  const endInput = document.getElementById('cumEndDate');
  const now = new Date();
  endInput.value = formatDateForInput(now);

  if (preset === 'thisMonth') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    startInput.value = formatDateForInput(firstDay);
  } else if (preset === 'last30Days') {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    startInput.value = formatDateForInput(d);
  } else if (preset === 'all') {
    startInput.value = '2026-01-01';
  }

  loadCumulativeReport();
}

async function loadCumulativeReport() {
  const startDate = document.getElementById('cumStartDate').value || getTodayDateStr();
  const endDate = document.getElementById('cumEndDate').value || getTodayDateStr();
  const projectId = document.getElementById('cumProjectFilter').value || AppState.selectedProjectId;
  const supplierId = document.getElementById('cumSupplierFilter').value;
  const materialId = document.getElementById('cumMaterialFilter').value;

  let url = `/api/reports/cumulative?startDate=${startDate}&endDate=${endDate}`;
  if (projectId) url += `&projectId=${projectId}`;
  if (supplierId) url += `&supplierId=${supplierId}`;
  if (materialId) url += `&materialId=${materialId}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    const summary = data.summary || {};

    document.getElementById('cumTotalTrips').textContent = summary.cumulative_trips || 0;
    document.getElementById('cumProjectCount').textContent = summary.project_count || 0;
    document.getElementById('cumSupplierCount').textContent = summary.supplier_count || 0;
    document.getElementById('cumActiveDays').textContent = summary.active_days || 0;

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
            <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700 text-sm">${m.volume.toFixed(2)} ${m.unit || 'm³'}</td>
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
            <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700">${s.volume.toFixed(2)} ${s.unit || 'm³'}</td>
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
  const startDate = document.getElementById('cumStartDate').value || getTodayDateStr();
  const endDate = document.getElementById('cumEndDate').value || getTodayDateStr();
  const projectId = document.getElementById('cumProjectFilter').value || AppState.selectedProjectId;

  let url = `/api/reports/export-excel?type=cumulative&startDate=${startDate}&endDate=${endDate}`;
  if (projectId) url += `&projectId=${projectId}`;
  window.location.href = url;
}

// ============================================================================
// 10. IN PHIẾU KIỂM ĐẾM / XUẤT NHẬP (RECEIPT PRINT)
// ============================================================================
async function fetchAndShowTicket(ticketId) {
  try {
    const res = await fetch(`/api/tickets?search=${ticketId}`);
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
  document.getElementById('prtTicketCode').textContent = ticket.ticket_code;
  document.getElementById('prtProjectName').textContent = ticket.project_name || 'DỰ ÁN CÔNG TRÌNH';
  document.getElementById('prtPlate').textContent = ticket.plate_number;
  document.getElementById('prtSupplier').textContent = ticket.supplier_name;
  document.getElementById('prtMaterial').textContent = ticket.material_name;

  const dim = (ticket.length > 0 && ticket.width > 0 && ticket.height > 0)
    ? `${ticket.length} x ${ticket.width} x ${ticket.height} m`
    : 'Theo quy chuẩn xe';
  document.getElementById('prtDimensions').textContent = dim;

  const unit = ticket.unit || 'm³';
  document.getElementById('prtStdVolume').textContent = `${ticket.standard_volume.toFixed(2)} ${unit}`;
  document.getElementById('prtActualVolume').textContent = `${ticket.actual_volume.toFixed(2)} ${unit}`;

  const adjRow = document.getElementById('prtAdjustRow');
  if (ticket.is_manual_adjusted) {
    adjRow.classList.remove('hidden');
    document.getElementById('prtAdjustReason').textContent = ticket.adjustment_reason || 'Điều chỉnh thủ công';
  } else {
    adjRow.classList.add('hidden');
  }

  document.getElementById('prtTimeIn').textContent = ticket.time_in;
  document.getElementById('prtTimeOut').textContent = ticket.time_out || '(Đang dỡ hàng tại bãi)';
  document.getElementById('prtNotes').textContent = ticket.notes || 'Không';

  document.getElementById('ticketModal').classList.remove('hidden');
}

function closeTicketModal() {
  document.getElementById('ticketModal').classList.add('hidden');
}

// ============================================================================
// 11. CẤU HÌNH DANH MỤC (PROJECTS, VEHICLES, MATERIALS, SUPPLIERS)
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

  if (sub === 'projects') renderSettingsProjects();
  if (sub === 'vehicles') renderSettingsVehicles();
  if (sub === 'materials') renderSettingsMaterials();
  if (sub === 'suppliers') renderSettingsSuppliers();
}

// --- Cấu hình Dự Án ---
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
  document.getElementById('projectForm').reset();
  document.getElementById('proj_id').value = '';
  document.getElementById('projectModalTitle').textContent = 'Thêm Dự Án / Công Trường Mới';
  document.getElementById('projectModal').classList.remove('hidden');
}

function closeProjectModal() {
  document.getElementById('projectModal').classList.add('hidden');
}

function editProject(id) {
  const p = AppState.projects.find(item => item.id === id);
  if (!p) return;

  document.getElementById('proj_id').value = p.id;
  document.getElementById('proj_name').value = p.name;
  document.getElementById('proj_code').value = p.code;
  document.getElementById('proj_location').value = p.location || '';
  document.getElementById('proj_status').value = p.status || 'ACTIVE';
  document.getElementById('proj_notes').value = p.notes || '';

  document.getElementById('projectModalTitle').textContent = `Chỉnh Sửa Dự Án: ${p.name}`;
  document.getElementById('projectModal').classList.remove('hidden');
}

async function saveProject(event) {
  event.preventDefault();
  const id = document.getElementById('proj_id').value;
  const name = document.getElementById('proj_name').value.trim();
  const code = document.getElementById('proj_code').value.trim();
  const location = document.getElementById('proj_location').value.trim();
  const status = document.getElementById('proj_status').value;
  const notes = document.getElementById('proj_notes').value.trim();

  const payload = { name, code, location, status, notes };

  try {
    const url = id ? `/api/projects/${id}` : '/api/projects';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
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
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể xóa dự án');

    showToast(`Đã xóa dự án ${name}`, 'success');
    await loadProjects();
    renderSettingsProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- Cấu hình Xe ---
function renderSettingsVehicles() {
  const tbody = document.getElementById('settingsVehiclesTable');
  if (!tbody) return;

  if (AppState.vehicles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-slate-400">Chưa có xe nào trong danh mục</td></tr>`;
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
        <td class="px-4 py-3 text-right font-mono font-bold text-blue-700 text-sm">${v.standard_volume.toFixed(2)}</td>
        <td class="px-4 py-3 text-center font-bold text-blue-800">${v.unit || 'm³'}</td>
        <td class="px-4 py-3 text-slate-600">${escapeHtml(v.default_material_name || '-')}</td>
        <td class="px-4 py-3 text-slate-400 text-xs">${escapeHtml(v.notes || '')}</td>
        <td class="px-4 py-3 text-center space-x-2">
          <button onclick="editVehicle(${v.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
          <button onclick="deleteVehicle(${v.id}, '${v.plate_number}')" class="text-red-600 hover:underline font-semibold">Xóa</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openVehicleModal() {
  document.getElementById('vehicleForm').reset();
  document.getElementById('veh_id').value = '';
  document.getElementById('vehicleModalTitle').textContent = 'Thêm Xe Vận Chuyển Mới';
  document.getElementById('vehGeoVol').textContent = 'Thể tích: 0.00 m³';
  document.getElementById('vehicleModal').classList.remove('hidden');
}

function closeVehicleModal() {
  document.getElementById('vehicleModal').classList.add('hidden');
}

function calcVehGeoVol() {
  const l = parseFloat(document.getElementById('veh_length').value) || 0;
  const w = parseFloat(document.getElementById('veh_width').value) || 0;
  const h = parseFloat(document.getElementById('veh_height').value) || 0;
  const vol = l * w * h;
  document.getElementById('vehGeoVol').textContent = `Thể tích: ${vol.toFixed(2)} m³`;

  const stdIn = document.getElementById('veh_std_volume');
  const unit = document.getElementById('veh_unit').value;
  if (stdIn && !stdIn.value && vol > 0 && unit === 'm³') {
    stdIn.value = vol.toFixed(2);
  }
}

function handleVehMaterialChange() {
  const matId = document.getElementById('veh_material').value;
  const mat = AppState.materials.find(m => m.id == matId);
  if (mat && mat.unit) {
    document.getElementById('veh_unit').value = mat.unit;
  }
}

function editVehicle(id) {
  const v = AppState.vehicles.find(item => item.id === id);
  if (!v) return;

  document.getElementById('veh_id').value = v.id;
  document.getElementById('veh_plate').value = v.plate_number;
  document.getElementById('veh_model').value = v.model_type || '';
  document.getElementById('veh_supplier').value = v.supplier_id || '';
  document.getElementById('veh_project').value = v.project_id || '';
  document.getElementById('veh_length').value = v.length || '';
  document.getElementById('veh_width').value = v.width || '';
  document.getElementById('veh_height').value = v.height || '';
  document.getElementById('veh_std_volume').value = v.standard_volume || '';
  document.getElementById('veh_unit').value = v.unit || 'm³';
  document.getElementById('veh_material').value = v.default_material_id || '';
  document.getElementById('veh_notes').value = v.notes || '';

  calcVehGeoVol();
  document.getElementById('vehicleModalTitle').textContent = `Chỉnh Sửa Xe ${v.plate_number}`;
  document.getElementById('vehicleModal').classList.remove('hidden');
}

async function saveVehicle(event) {
  event.preventDefault();
  const id = document.getElementById('veh_id').value;
  const plate = document.getElementById('veh_plate').value.trim().toUpperCase();
  const model = document.getElementById('veh_model').value.trim();
  const supplierId = document.getElementById('veh_supplier').value;
  const projectId = document.getElementById('veh_project').value;
  const length = parseFloat(document.getElementById('veh_length').value) || 0;
  const width = parseFloat(document.getElementById('veh_width').value) || 0;
  const height = parseFloat(document.getElementById('veh_height').value) || 0;
  const stdVolume = parseFloat(document.getElementById('veh_std_volume').value) || 0;
  const unit = document.getElementById('veh_unit').value;
  const materialId = document.getElementById('veh_material').value;
  const notes = document.getElementById('veh_notes').value.trim();

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

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu thông tin xe');

    closeVehicleModal();
    showToast(`✓ Đã lưu thông tin xe ${data.plate_number}`, 'success');
    await loadVehicles();
    renderSettingsVehicles();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteVehicle(id, plate) {
  if (!confirm(`Bạn có chắc chắn muốn xóa xe ${plate} khỏi danh mục?`)) return;

  try {
    const res = await fetch(`/api/vehicles/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Không thể xóa xe');

    showToast(`Đã xóa xe ${plate}`, 'success');
    await loadVehicles();
    renderSettingsVehicles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- Cấu hình Loại Vật Liệu (Hỗ trợ nhập hoặc chọn ĐVT) ---
function renderSettingsMaterials() {
  const tbody = document.getElementById('settingsMaterialsTable');
  if (!tbody) return;

  if (AppState.materials.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400">Chưa có loại vật liệu nào</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.materials.map(m => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-4 py-3 font-mono text-slate-600 font-semibold">${m.code}</td>
      <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(m.name)}</td>
      <td class="px-4 py-3 text-center font-bold text-blue-700 bg-blue-50/50">${m.unit || 'm³'}</td>
      <td class="px-4 py-3 text-center font-mono font-semibold">${m.total_trips || 0}</td>
      <td class="px-4 py-3 text-right font-mono font-bold text-emerald-700">${(m.cumulative_volume || 0).toFixed(2)} ${m.unit || 'm³'}</td>
      <td class="px-4 py-3 text-slate-500 text-xs">${escapeHtml(m.description || '')}</td>
      <td class="px-4 py-3 text-center space-x-2">
        <button onclick="editMaterial(${m.id})" class="text-blue-600 hover:underline font-semibold">Sửa</button>
        <button onclick="deleteMaterial(${m.id}, '${escapeHtml(m.name)}')" class="text-red-600 hover:underline font-semibold">Xóa</button>
      </td>
    </tr>
  `).join('');
}

function openMaterialModal() {
  document.getElementById('materialForm').reset();
  document.getElementById('mat_id').value = '';
  document.getElementById('mat_unit').value = 'm³';
  document.getElementById('materialModalTitle').textContent = 'Thêm Loại Vật Liệu Mới';
  document.getElementById('materialModal').classList.remove('hidden');
}

function closeMaterialModal() {
  document.getElementById('materialModal').classList.add('hidden');
}

function editMaterial(id) {
  const m = AppState.materials.find(item => item.id === id);
  if (!m) return;

  document.getElementById('mat_id').value = m.id;
  document.getElementById('mat_name').value = m.name;
  document.getElementById('mat_code').value = m.code;
  document.getElementById('mat_unit').value = m.unit || 'm³';
  document.getElementById('mat_desc').value = m.description || '';

  document.getElementById('materialModalTitle').textContent = `Chỉnh Sửa Vật Liệu: ${m.name}`;
  document.getElementById('materialModal').classList.remove('hidden');
}

async function saveMaterial(event) {
  event.preventDefault();
  const id = document.getElementById('mat_id').value;
  const name = document.getElementById('mat_name').value.trim();
  const code = document.getElementById('mat_code').value.trim();
  const unit = document.getElementById('mat_unit').value.trim() || 'm³';
  const desc = document.getElementById('mat_desc').value.trim();

  const payload = { name, code, unit, description: desc };

  try {
    const url = id ? `/api/materials/${id}` : '/api/materials';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu loại vật liệu');

    closeMaterialModal();
    showToast(`✓ Đã lưu vật liệu: ${data.name} (ĐVT: ${data.unit})`, 'success');
    await loadMaterials();
    renderSettingsMaterials();

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteMaterial(id, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa loại vật liệu "${name}"?`)) return;

  try {
    const res = await fetch(`/api/materials/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Không thể xóa vật liệu');

    showToast(`Đã xóa vật liệu ${name}`, 'success');
    await loadMaterials();
    renderSettingsMaterials();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- Cấu hình Nhà Cung Cấp ---
function renderSettingsSuppliers() {
  const tbody = document.getElementById('settingsSuppliersTable');
  if (!tbody) return;

  if (AppState.suppliers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-400">Chưa có nhà cung cấp nào</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.suppliers.map(s => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-4 py-3 font-mono text-slate-600 font-semibold">${s.code}</td>
      <td class="px-4 py-3 font-bold text-slate-900">${escapeHtml(s.name)}</td>
      <td class="px-4 py-3 font-mono text-slate-600">${s.phone || '-'}</td>
      <td class="px-4 py-3 text-slate-700">${escapeHtml(s.contact_person || '-')}</td>
      <td class="px-4 py-3 text-center font-mono font-semibold">${s.vehicle_count || 0}</td>
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
  document.getElementById('supplierForm').reset();
  document.getElementById('supp_id').value = '';
  document.getElementById('supplierModalTitle').textContent = 'Thêm Nhà Cung Cấp Mới';
  document.getElementById('supplierModal').classList.remove('hidden');
}

function closeSupplierModal() {
  document.getElementById('supplierModal').classList.add('hidden');
}

function editSupplier(id) {
  const s = AppState.suppliers.find(item => item.id === id);
  if (!s) return;

  document.getElementById('supp_id').value = s.id;
  document.getElementById('supp_name').value = s.name;
  document.getElementById('supp_code').value = s.code;
  document.getElementById('supp_phone').value = s.phone || '';
  document.getElementById('supp_contact').value = s.contact_person || '';
  document.getElementById('supp_notes').value = s.notes || '';

  document.getElementById('supplierModalTitle').textContent = `Chỉnh Sửa Nhà Cung Cấp: ${s.name}`;
  document.getElementById('supplierModal').classList.remove('hidden');
}

async function saveSupplier(event) {
  event.preventDefault();
  const id = document.getElementById('supp_id').value;
  const name = document.getElementById('supp_name').value.trim();
  const code = document.getElementById('supp_code').value.trim();
  const phone = document.getElementById('supp_phone').value.trim();
  const contact = document.getElementById('supp_contact').value.trim();
  const notes = document.getElementById('supp_notes').value.trim();

  const payload = { name, code, phone, contact_person: contact, notes };

  try {
    const url = id ? `/api/suppliers/${id}` : '/api/suppliers';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
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
    const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Không thể xóa nhà cung cấp');

    showToast(`Đã xóa nhà cung cấp ${name}`, 'success');
    await loadSuppliers();
    renderSettingsSuppliers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================================
// 12. TIỆN ÍCH HỖ TRỢ (TOAST & HELPERS)
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
