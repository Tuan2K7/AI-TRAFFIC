/**
 * Danh mục loại sự cố hạ tầng — dùng chung cho API, bản đồ và sidebar.
 * Mọi nơi hiển thị tên/icon/màu của 1 loại sự cố nên import từ đây
 * để tránh lệch dữ liệu giữa các thành phần (Module 1 Python cũng gửi
 * đúng các key này trong trường `type`).
 */

export type IncidentTypeKey = 'O_GA' | 'VET_LUN' | 'NGAP_NUOC' | 'NAP_CONG_HONG';

export interface IncidentTypeMeta {
  key: IncidentTypeKey;
  label: string;       // Tên hiển thị tiếng Việt
  icon: string;         // Glyph hiển thị trong badge/chip
  color: string;        // Màu nhận diện riêng cho loại sự cố (dùng trong popup/legend)
}

export const INCIDENT_TYPES: Record<IncidentTypeKey, IncidentTypeMeta> = {
  O_GA: {
    key: 'O_GA',
    label: 'Ổ gà',
    icon: '⚠️',
    color: '#f59e0b',
  },
  VET_LUN: {
    key: 'VET_LUN',
    label: 'Vết lún',
    icon: '📉',
    color: '#8b5cf6',
  },
  NGAP_NUOC: {
    key: 'NGAP_NUOC',
    label: 'Ngập nước',
    icon: '💧',
    color: '#0ea5e9',
  },
  NAP_CONG_HONG: {
    key: 'NAP_CONG_HONG',
    label: 'Nắp cống hỏng',
    icon: '🚫',
    color: '#ef4444',
  },
};

export const INCIDENT_TYPE_ORDER: IncidentTypeKey[] = ['O_GA', 'VET_LUN', 'NGAP_NUOC', 'NAP_CONG_HONG'];

/** Một số hệ thống cũ/Python script cũ có thể gửi nhãn khác — chuẩn hoá về 4 key trên. */
const LEGACY_ALIASES: Record<string, IncidentTypeKey> = {
  O_GA_NGUY_HIEM: 'O_GA',
  POTHOLE: 'O_GA',
  MAT_DUONG_LUN: 'VET_LUN',
  LUN_MAT_DUONG: 'VET_LUN',
  RUTTING: 'VET_LUN',
  FLOOD: 'NGAP_NUOC',
  NGAP: 'NGAP_NUOC',
  NAP_CONG: 'NAP_CONG_HONG',
  MANHOLE: 'NAP_CONG_HONG',
};

export function normalizeIncidentType(raw: string): IncidentTypeKey {
  const upper = (raw || '').toUpperCase().trim();
  if (upper in INCIDENT_TYPES) return upper as IncidentTypeKey;
  if (upper in LEGACY_ALIASES) return LEGACY_ALIASES[upper];
  return 'O_GA'; // fallback an toàn — không để dữ liệu lạ làm vỡ UI
}

export function getIncidentMeta(type: string): IncidentTypeMeta {
  return INCIDENT_TYPES[normalizeIncidentType(type)];
}
