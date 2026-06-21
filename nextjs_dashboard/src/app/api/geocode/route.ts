/**
 * Proxy tìm kiếm địa điểm cho thanh search trên bản đồ.
 * Dùng OpenStreetMap Nominatim (miễn phí, không cần API key) — bị giới hạn
 * khu vực Hà Nội qua viewbox. Chạy ở server để gắn User-Agent đúng chính
 * sách của Nominatim (bắt buộc) và tránh lỗi CORS khi gọi từ trình duyệt.
 *
 * Lưu ý: Nominatim free chỉ cho phép ~1 request/giây và không dành cho
 * traffic lớn/thương mại. Nếu Dashboard lên production có nhiều người
 * dùng đồng thời, nên đổi sang dịch vụ geocoding có trả phí (Mapbox,
 * Google Geocoding, LocationIQ...) hoặc tự host Nominatim.
 */

import { NextRequest, NextResponse } from 'next/server';

// Bounding box quanh Hà Nội: left,top,right,bottom (lon,lat)
const HANOI_VIEWBOX = '105.45,21.40,106.05,20.80';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}` +
      `&limit=5&viewbox=${HANOI_VIEWBOX}&bounded=1&countrycodes=vn&addressdetails=0`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'AITrafficUTC-DecentralizedGrid/1.0 (du an nghien cuu UTC, lien he qua dashboard)',
        'Accept-Language': 'vi',
      },
      // Tránh cache lỗi của Next.js fetch cho dữ liệu thay đổi theo người dùng
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ results: [], error: `Nominatim HTTP ${res.status}` }, { status: 502 });
    }

    const data: Array<{ lat: string; lon: string; display_name: string }> = await res.json();
    const results = data.map(d => ({
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      name: d.display_name,
    }));

    return NextResponse.json({ results });
  } catch (err) {
    console.error('[API/geocode] Lỗi tìm kiếm:', err);
    return NextResponse.json({ results: [], error: 'Lỗi kết nối tới dịch vụ bản đồ' }, { status: 502 });
  }
}
