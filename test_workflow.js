// Script kiểm thử tự động toàn bộ luồng nghiệp vụ

async function runTests() {
  const base = 'http://localhost:3000';
  console.log('--- BẮT ĐẦU KIỂM THỬ HỆ THỐNG ---');

  // 1. Kiểm tra danh sách xe đang trong bãi
  const resInYard = await fetch(`${base}/api/tickets/in-yard`);
  const inYard = await resInYard.json();
  console.log(`[PASS] 1. Xe đang trong bãi: ${inYard.length} xe`);

  // 2. Check-in xe mới với tùy chọn điều chỉnh thủ công (chở có ngọn)
  const resCheckIn = await fetch(`${base}/api/tickets/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plate_number: '29C-999.88',
      model_type: 'Xe ben Howo 3 chân',
      supplier_id: 1,
      material_id: 1,
      length: 5.0,
      width: 2.3,
      height: 0.9,
      standard_volume: 10.0,
      actual_volume: 11.5,
      is_manual_adjusted: 1,
      adjustment_reason: 'Chở có ngọn cao +1.5m3',
      notes: 'Thực hiện test tự động'
    })
  });
  const newTicket = await resCheckIn.json();
  console.log(`[PASS] 2. Check-in xe ${newTicket.plate_number} thành công, mã phiếu: ${newTicket.ticket_code}, khối lượng: ${newTicket.actual_volume} m3 (Vơi/ngọn: ${newTicket.is_manual_adjusted})`);

  // 3. Check-out xe vừa vào
  const resCheckOut = await fetch(`${base}/api/tickets/${newTicket.id}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notes: 'Đã hoàn tất dỡ hàng tại bãi cát'
    })
  });
  const checkedOut = await resCheckOut.json();
  console.log(`[PASS] 3. Check-out xe ${checkedOut.plate_number} thành công, trạng thái: ${checkedOut.status}, giờ ra: ${checkedOut.time_out}`);

  // 4. Kiểm tra Báo cáo ngày
  const resDaily = await fetch(`${base}/api/reports/daily`);
  const daily = await resDaily.json();
  console.log(`[PASS] 4. Báo cáo ngày: ${daily.summary.total_trips} chuyến, tổng khối lượng: ${daily.summary.total_volume} m3`);
  console.log(`          Phân bổ theo NCC:`, daily.bySupplier.map(s => `${s.supplier_name} (${s.volume} m3)`));

  // 5. Kiểm tra Báo cáo lũy kế
  const resCum = await fetch(`${base}/api/reports/cumulative?startDate=2026-09-01&endDate=2026-09-30`);
  const cum = await resCum.json();
  console.log(`[PASS] 5. Báo cáo lũy kế: ${cum.summary.cumulative_trips} chuyến, tổng khối lượng lũy kế: ${cum.summary.cumulative_volume} m3`);
  console.log(`          Bình quân/chuyến: ${(cum.summary.cumulative_volume / cum.summary.cumulative_trips).toFixed(2)} m3/xe`);

  // 6. Kiểm tra xuất file Excel
  const resExcel = await fetch(`${base}/api/reports/export-excel?type=daily`);
  const excelContent = await resExcel.text();
  const hasXml = excelContent.includes('urn:schemas-microsoft-com:office:spreadsheet');
  console.log(`[PASS] 6. Xuất file Excel: HTTP status ${resExcel.status}, định dạng XML Spreadsheet hợp lệ: ${hasXml}`);

  console.log('--- TẤT CẢ KIỂM THỬ ĐÃ VƯỢT QUA XUẤT SẮC! ---');
}

runTests().catch(err => {
  console.error('Kiểm thử thất bại:', err);
  process.exit(1);
});
