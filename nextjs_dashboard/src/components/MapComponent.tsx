'use client';

import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import { getIncidentMeta } from '@/lib/incidentTypes';
import type { SensorEvent } from '@/lib/consensus';

interface SearchPin {
  lat: number;
  lng: number;
  name: string;
}

interface MapComponentProps {
  events: SensorEvent[];
  selectedEvent: SensorEvent | null;
  onSelectEvent: (e: SensorEvent) => void;
  flyToCoord: [number, number] | null;
  sidebarCollapsed: boolean;
  searchPin?: SearchPin | null;
}

export default function MapComponent({ events, selectedEvent, onSelectEvent, flyToCoord, sidebarCollapsed, searchPin }: MapComponentProps) {
  const mapRef        = useRef<L.Map | null>(null);
  const markersRef    = useRef<Map<string, L.CircleMarker>>(new Map());
  const searchPinRef  = useRef<L.Marker | null>(null);
  const containerRef  = useRef<HTMLDivElement>(null);

  // Khởi tạo bản đồ một lần
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    const map = L.map(containerRef.current, {
      center: [21.0285, 105.8048],
      zoom: 13,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=vi', {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      attribution: 'Map data &copy; Google | AI Traffic UTC',
    }).addTo(map);

    map.attributionControl.setPrefix(
      '<a href="https://utc.edu.vn" target="_blank" style="color:#0284c7;font-weight:700;">AI Traffic UTC</a>'
    );

    mapRef.current = map;
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Cập nhật markers khi events thay đổi
  useEffect(() => {
    if (!mapRef.current) return;
    const map     = mapRef.current;
    const current = markersRef.current;
    const newIds  = new Set(events.map(e => e.id));

    // Xoá markers không còn trong danh sách (đã lọc theo bộ lọc loại sự cố, hoặc bị đẩy ra khỏi giới hạn lưu trữ)
    for (const [id, marker] of current.entries()) {
      if (!newIds.has(id)) {
        map.removeLayer(marker);
        current.delete(id);
      }
    }

    for (const event of events) {
      const lat    = parseFloat(event.lat);
      const lng    = parseFloat(event.lng);
      const meta   = getIncidentMeta(event.type);
      const trusted = event.consensus || event.verified;

      const popupContent = `
        <div style="font-family:'Inter',sans-serif;min-width:230px;padding:4px;">
          <div style="font-weight:800;font-size:13px;color:#1e293b;margin-bottom:6px;">${meta.icon} ${meta.label}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:3px;">📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:3px;">🕐 ${event.timestamp}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:3px;">🤖 Độ tin cậy: <b style="color:#ef4444">${event.confidence}</b></div>
          <div style="font-size:11px;color:#6366f1;margin-bottom:6px;">Nguồn: <b>${event.device_id}</b>${event.consensusCount > 1 ? ` (+${event.consensusCount - 1} node khác)` : ''}</div>
          <div style="font-size:11px;background:${trusted ? '#f0fdf4' : '#fef3c7'};padding:5px 8px;border-radius:6px;font-weight:600;color:${trusted ? '#15803d' : '#92400e'}">
            ${event.verified ? '✅ Đã đóng dấu Blockchain' : event.consensus ? '✅ Đã đồng thuận đám đông' : '⏳ Đang xác minh'}
          </div>
          ${event.blockchain_tx ? `<a href="https://preprod.cardanoscan.io/transaction/${event.blockchain_tx}" target="_blank" style="font-size:10px;color:#2563eb;display:block;margin-top:4px;word-break:break-all">${event.blockchain_tx.slice(0, 32)}...</a>` : ''}
        </div>`;

      const style = {
        color:       trusted ? '#10b981' : '#ef4444',
        fillColor:   trusted ? '#34d399' : '#f87171',
        fillOpacity: event.verified ? 0.98 : trusted ? 0.9 : 0.65,
        radius:      event.verified ? 11 : trusted ? 9 : 7,
      };

      if (current.has(event.id)) {
        const marker = current.get(event.id)!;
        marker.setStyle({ ...style, weight: 2 });
        marker.bindPopup(popupContent);
      } else {
        const marker = L.circleMarker([lat, lng], {
          ...style,
          weight:    2,
          className: 'blinking-marker',
        }).addTo(map);

        marker.bindPopup(popupContent);
        marker.on('click', () => onSelectEvent(event));
        current.set(event.id, marker);
      }
    }
  }, [events, onSelectEvent]);

  // Marker địa điểm tìm kiếm (thanh search trên cùng)
  useEffect(() => {
    if (!mapRef.current) return;
    if (searchPinRef.current) {
      mapRef.current.removeLayer(searchPinRef.current);
      searchPinRef.current = null;
    }
    if (!searchPin) return;

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:26px;height:26px;background:#0284c7;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:13px;">📍</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const marker = L.marker([searchPin.lat, searchPin.lng], { icon }).addTo(mapRef.current);
    marker.bindPopup(`<div style="font-family:'Inter',sans-serif;font-size:12px;max-width:220px;">${searchPin.name}</div>`).openPopup();
    searchPinRef.current = marker;
  }, [searchPin]);

  // Bay đến toạ độ khi người dùng click card / tìm kiếm
  useEffect(() => {
    if (!flyToCoord || !mapRef.current) return;
    mapRef.current.flyTo(flyToCoord, 17, { animate: true, duration: 1.2 });
    const marker = markersRef.current.get(selectedEvent?.id || '');
    if (marker) {
      setTimeout(() => marker.openPopup(), 1100);
    }
  }, [flyToCoord, selectedEvent]);

  // Resize bản đồ khi sidebar toggle
  const invalidate = useCallback(() => {
    if (mapRef.current) mapRef.current.invalidateSize();
  }, []);

  useEffect(() => {
    const timer = setTimeout(invalidate, 320);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed, invalidate]);

  return (
    <div
      id="map"
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 1 }}
    />
  );
}
