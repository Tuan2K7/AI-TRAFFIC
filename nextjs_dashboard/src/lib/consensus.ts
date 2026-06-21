/**
 * Module 2 — lõi tính "Đồng thuận đám đông" (crowd consensus) và thống kê mạng.
 *
 * Ý tưởng: mỗi Edge Node (camera/smartphone) có thể báo nhầm hoặc gặp nhiễu.
 * Một sự cố chỉ được coi là ĐÃ XÁC THỰC khi có >=2 Edge Node khác nhau cùng
 * báo cáo loại sự cố giống nhau, ở gần nhau (bán kính CONSENSUS_RADIUS_M),
 * trong khoảng thời gian gần nhau (CONSENSUS_WINDOW_MS). Đây là một cơ chế
 * thật (tính toán từ dữ liệu), không phải nhãn trang trí — tách biệt với
 * việc đóng dấu Blockchain (vẫn là hành động thủ công, vĩnh viễn, ở tab Sổ cái).
 */

import { IncidentTypeKey, normalizeIncidentType } from './incidentTypes';

export interface SensorEvent {
  id: string;
  lat: string;
  lng: string;
  type: IncidentTypeKey;
  confidence: string;        // "87.0%"
  timestamp: string;         // chuỗi hiển thị (giờ địa phương)
  created_at: number;        // epoch ms — dùng để tính toán nội bộ
  device_id: string;
  consensus: boolean;        // đã được >=2 node độc lập xác nhận
  consensusCount: number;    // số node độc lập đã xác nhận
  blockchain_tx?: string;
  verified: boolean;         // đã đóng dấu Blockchain (hành động thủ công)
}

export interface NetworkStats {
  total: number;
  consensusCount: number;
  activeEdgeNodes: number;
  avgTrustPercent: number;
}

export const CONSENSUS_RADIUS_M = 60;          // 2 báo cáo trong vòng 60m được coi là cùng 1 sự cố
export const CONSENSUS_WINDOW_MS = 15 * 60_000; // ...và trong vòng 15 phút
export const ACTIVE_NODE_WINDOW_MS = 10 * 60_000; // Edge Node "active" = có báo cáo trong 10 phút gần nhất

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLam = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLam / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function parseConfidencePercent(confidence: string): number {
  const n = parseFloat((confidence || '0').replace('%', '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** Tính lại cờ đồng thuận cho TOÀN BỘ danh sách — gọi lại mỗi khi có sự kiện mới. */
export function recomputeConsensus(events: SensorEvent[]): void {
  for (const evt of events) {
    const lat = parseFloat(evt.lat);
    const lng = parseFloat(evt.lng);
    const corroborators = new Set<string>([evt.device_id]);

    for (const other of events) {
      if (other.id === evt.id) continue;
      if (normalizeIncidentType(other.type) !== normalizeIncidentType(evt.type)) continue;
      if (Math.abs(other.created_at - evt.created_at) > CONSENSUS_WINDOW_MS) continue;
      const dist = haversineMeters(lat, lng, parseFloat(other.lat), parseFloat(other.lng));
      if (dist <= CONSENSUS_RADIUS_M) corroborators.add(other.device_id);
    }

    evt.consensusCount = corroborators.size;
    evt.consensus = corroborators.size >= 2;
  }
}

export function computeNetworkStats(events: SensorEvent[]): NetworkStats {
  const now = Date.now();
  const activeNodes = new Set(
    events.filter(e => now - e.created_at <= ACTIVE_NODE_WINDOW_MS).map(e => e.device_id)
  );
  const avg = events.length
    ? Math.round(events.reduce((sum, e) => sum + parseConfidencePercent(e.confidence), 0) / events.length)
    : 0;

  return {
    total: events.length,
    consensusCount: events.filter(e => e.consensus).length,
    activeEdgeNodes: activeNodes.size,
    avgTrustPercent: avg,
  };
}
