/**
 * Module 2: API /api/sensor
 * "Cổng đón khách" nhận dữ liệu từ Module 1 (Python AI / Edge Node) và
 * lưu vào bộ nhớ toàn cục để Dashboard hiển thị + tính đồng thuận đám đông.
 *
 * Lưu ý production: bộ nhớ in-memory sẽ mất khi server restart hoặc khi
 * chạy nhiều instance (serverless). Với demo/đồ án 1 instance luôn-bật
 * (Render/VPS) thì ổn; nếu cần bền vững thật, thay global.sensorEvents
 * bằng một DB nhẹ (SQLite/Postgres/Upstash Redis).
 */

import { NextRequest, NextResponse } from 'next/server';
import { normalizeIncidentType } from '@/lib/incidentTypes';
import { SensorEvent, recomputeConsensus, computeNetworkStats } from '@/lib/consensus';

const MAX_EVENTS = 200;

declare global {
  var sensorEvents: SensorEvent[];
}

if (!global.sensorEvents) {
  global.sensorEvents = [];
}

// POST: Nhận dữ liệu từ Python AI / Edge Node
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { lat, lng, type, confidence, timestamp, device_id } = body;

    if (!lat || !lng || !type) {
      return NextResponse.json({ error: 'Thiếu trường bắt buộc: lat, lng, type' }, { status: 400 });
    }

    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      return NextResponse.json({ error: 'lat/lng không hợp lệ' }, { status: 400 });
    }

    const newEvent: SensorEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      lat: String(lat),
      lng: String(lng),
      type: normalizeIncidentType(type),
      confidence: confidence || '0%',
      timestamp: timestamp || new Date().toLocaleString('vi-VN'),
      created_at: Date.now(),
      device_id: device_id || 'EdgeNode-UNKNOWN',
      consensus: false,
      consensusCount: 1,
      verified: false,
    };

    global.sensorEvents.unshift(newEvent);
    if (global.sensorEvents.length > MAX_EVENTS) {
      global.sensorEvents.length = MAX_EVENTS;
    }

    recomputeConsensus(global.sensorEvents);

    const updated = global.sensorEvents.find(e => e.id === newEvent.id)!;
    console.log(
      `[API/sensor] ✅ ${device_id || 'unknown'} → ${updated.type} @ ${lat},${lng}` +
      (updated.consensus ? ` | ĐỒNG THUẬN (${updated.consensusCount} node)` : ' | chờ đồng thuận')
    );

    return NextResponse.json({
      message: 'Dữ liệu đã nhận thành công',
      event_id: newEvent.id,
      consensus: updated.consensus,
      consensus_count: updated.consensusCount,
      total_events: global.sensorEvents.length,
    });

  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }
}

// GET: Trả về danh sách sự kiện + thống kê mạng để Dashboard polling
export async function GET() {
  const events = global.sensorEvents || [];
  return NextResponse.json({
    events,
    stats: computeNetworkStats(events),
  });
}
