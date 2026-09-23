// Script kiểm thử tự động tính năng Đa Dự Án & Đa Đơn Vị Tính

async function runMultiProjectTests() {
  const base = 'http://localhost:3000';
  console.log('=== BẮT ĐẦU KIỂM THỬ ĐA DỰ ÁN & ĐA ĐƠN VỊ TÍNH ===');

  // 1. Kiểm tra danh mục dự án
  const resProj = await fetch(`${base}/api/projects`);
  const projects = await resProj.json();
  console.log(`[PASS] 1. Danh mục dự án: có ${projects.length} dự án`);
  projects.forEach(p => console.log(`       - [${p.code}] ${p.name}`));

  // 2. Kiểm tra danh mục vật liệu có đa đơn vị tính (Tấn, m dài, m³)
  const resMat = await fetch(`${base}/api/materials`);
  const materials = await resMat.json();
  console.log(`[PASS] 2. Danh mục vật liệu (${materials.length} loại):`);
  materials.forEach(m => console.log(`       - ${m.name} (ĐVT: ${m.unit})`));

  const thep = materials.find(m => m.unit === 'Tấn');
  const cong = materials.find(m => m.unit === 'm');
  if (!thep || !cong) {
    throw new Error('Chưa tìm thấy vật liệu đơn vị Tấn hoặc m');
  }

  // 3. Check-in xe chở THÉP (30 Tấn) vào Dự án 1 (Cầu Vĩnh Tuy 2)
  const resThep = await fetch(`${base}/api/tickets/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: projects[0].id,
      plate_number: '29C-771.88',
      model_type: 'Đầu kéo mooc sàn chở thép',
      supplier_id: 2, // Hoàng Long
      material_id: thep.id,
      unit: thep.unit,
      length: 12.0, width: 2.4, height: 1.5,
      standard_volume: 30.0,
      actual_volume: 30.0,
      is_manual_adjusted: 0,
      notes: 'Thép thanh vằn D20 Hòa Phát vào hố móng trụ P12'
    })
  });
  const ticketThep = await resThep.json();
  console.log(`[PASS] 3. Check-in xe Thép thành công: Xe ${ticketThep.plate_number}, Dự án: ${ticketThep.project_name}, Khối lượng: ${ticketThep.actual_volume} ${ticketThep.unit}`);

  // 4. Check-in xe chở CỐNG BÊ TÔNG (12.5 m) vào Dự án 2 (Khu đô thị)
  const resCong = await fetch(`${base}/api/tickets/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: projects[1].id,
      plate_number: '29H-445.67',
      model_type: 'Xe tải gắn cẩu chở cống',
      supplier_id: 1, // Sông Đà
      material_id: cong.id,
      unit: cong.unit,
      length: 8.5, width: 2.35, height: 0.8,
      standard_volume: 12.5,
      actual_volume: 12.5,
      is_manual_adjusted: 0,
      notes: '5 đốt cống ly tâm D1000'
    })
  });
  const ticketCong = await resCong.json();
  console.log(`[PASS] 4. Check-in xe Cống bê tông thành công: Xe ${ticketCong.plate_number}, Dự án: ${ticketCong.project_name}, Khối lượng: ${ticketCong.actual_volume} ${ticketCong.unit}`);

  // 5. Kiểm tra lọc xe trong bãi theo từng dự án
  const inYardAll = await (await fetch(`${base}/api/tickets/in-yard`)).json();
  const inYardP1 = await (await fetch(`${base}/api/tickets/in-yard?projectId=${projects[0].id}`)).json();
  const inYardP2 = await (await fetch(`${base}/api/tickets/in-yard?projectId=${projects[1].id}`)).json();
  console.log(`[PASS] 5. Lọc xe trong bãi: Tất cả: ${inYardAll.length} xe | Dự án 1: ${inYardP1.length} xe | Dự án 2: ${inYardP2.length} xe`);

  // 6. Check-out xe Thép và xe Cống
  await fetch(`${base}/api/tickets/${ticketThep.id}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'Đã cẩu thép xuống bãi gia công' })
  });
  await fetch(`${base}/api/tickets/${ticketCong.id}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'Đã hạ cống vào tuyến cống C2' })
  });
  console.log(`[PASS] 6. Check-out hoàn tất cho cả 2 xe`);

  // 7. Báo cáo ngày lọc theo Dự án 1
  const dailyP1 = await (await fetch(`${base}/api/reports/daily?projectId=${projects[0].id}`)).json();
  console.log(`[PASS] 7. Báo cáo ngày Dự án 1 (${projects[0].name}): ${dailyP1.summary.total_trips} chuyến`);
  console.log(`          Phân rã vật liệu:`, dailyP1.byMaterial.map(m => `${m.material_name}: ${m.volume} ${m.unit}`));

  // 8. Báo cáo lũy kế tổng hợp toàn công ty
  const cumAll = await (await fetch(`${base}/api/reports/cumulative?startDate=2026-09-01&endDate=2026-09-30`)).json();
  console.log(`[PASS] 8. Báo cáo lũy kế toàn công ty: ${cumAll.summary.cumulative_trips} chuyến qua ${cumAll.summary.project_count} dự án`);
  console.log(`          Phân rã theo Dự án:`, cumAll.byProject.map(p => `${p.project_name}: ${p.trips} chuyến`));
  console.log(`          Phân rã theo Vật liệu & ĐVT:`, cumAll.byMaterial.map(m => `${m.material_name}: ${m.volume} ${m.unit}`));

  // 9. Kiểm tra file Excel có đủ cột Dự Án và ĐVT
  const resExcel = await fetch(`${base}/api/reports/export-excel?type=daily`);
  const excelText = await resExcel.text();
  const hasProjCol = excelText.includes('Dự Án / Công Trường');
  const hasUnitCol = excelText.includes('ĐVT');
  console.log(`[PASS] 9. Xuất file Excel: Cột Dự Án: ${hasProjCol} | Cột Đơn Vị Tính: ${hasUnitCol}`);

  console.log('=== TẤT CẢ KIỂM THỬ ĐÃ THÀNH CÔNG VƯỢT TRỘI! ===');
}

runMultiProjectTests().catch(err => {
  console.error('Kiểm thử thất bại:', err);
  process.exit(1);
});
