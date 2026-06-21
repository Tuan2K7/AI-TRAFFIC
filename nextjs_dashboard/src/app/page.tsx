'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet } from '@meshsdk/react';
import { Transaction, BrowserWallet, BlockfrostProvider } from '@meshsdk/core';
import dynamic from 'next/dynamic';
import { INCIDENT_TYPES, INCIDENT_TYPE_ORDER, IncidentTypeKey, getIncidentMeta } from '@/lib/incidentTypes';
import type { SensorEvent, NetworkStats } from '@/lib/consensus';

// Lazy load Map component (Leaflet không chạy trên server)
const MapComponent = dynamic(() => import('@/components/MapComponent'), {
  ssr: false,
  loading: () => (
    <div style={{ position: 'absolute', inset: 0, background: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.9rem' }}>
      🗺 Đang khởi tạo bản đồ...
    </div>
  ),
});

type FilterValue = 'ALL' | IncidentTypeKey;

interface SearchResult { lat: number; lng: number; name: string; }
interface SearchPin { lat: number; lng: number; name: string; }

const CHIP_LABEL: Record<IncidentTypeKey, string> = {
  O_GA: 'Ổ gà',
  VET_LUN: 'Vết lún',
  NGAP_NUOC: 'Ngập nước',
  NAP_CONG_HONG: 'Nắp cống',
};

const EMPTY_STATS: NetworkStats = { total: 0, consensusCount: 0, activeEdgeNodes: 0, avgTrustPercent: 0 };

// ── Component chính ─────────────────────────────────────────────
export default function Home() {
  const { connected, connecting, connect, disconnect, name } = useWallet();

  const [events, setEvents]               = useState<SensorEvent[]>([]);
  const [stats, setStats]                 = useState<NetworkStats>(EMPTY_STATS);
  const [selectedEvent, setSelectedEvent] = useState<SensorEvent | null>(null);
  const [txHash, setTxHash]               = useState<string>('');
  const [loading, setLoading]             = useState<boolean>(false);
  const [txStatus, setTxStatus]           = useState<string>('');
  const [isMounted, setIsMounted]         = useState<boolean>(false);
  const [clock, setClock]                 = useState<string>('--:--:--');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab]         = useState<'feed' | 'ledger'>('feed');
  const [flyToCoord, setFlyToCoord]       = useState<[number, number] | null>(null);
  const [filter, setFilter]               = useState<FilterValue>('ALL');

  // Thanh tìm kiếm vị trí
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen]       = useState(false);
  const [searchPin, setSearchPin]         = useState<SearchPin | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const blockfrostKey = process.env.NEXT_PUBLIC_BLOCKFROST_API_KEY || '';

  useEffect(() => {
    setIsMounted(true);
    const clockTimer = setInterval(() => {
      setClock(new Date().toLocaleTimeString('vi-VN', { hour12: false }));
    }, 1000);
    pollingRef.current = setInterval(fetchEvents, 2000);
    fetchEvents();

    return () => {
      clearInterval(clockTimer);
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/sensor');
      if (res.ok) {
        const data: { events: SensorEvent[]; stats: NetworkStats } = await res.json();
        setEvents(data.events || []);
        setStats(data.stats || EMPTY_STATS);
      }
    } catch {
      // Bỏ qua lỗi mạng — sẽ thử lại ở lượt polling sau
    }
  }, []);

  // ── Tìm kiếm vị trí (Nominatim, qua proxy /api/geocode) ──────
  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    setSearchLoading(true);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data: { results: SearchResult[] } = await res.json();
      setSearchResults(data.results || []);
      setSearchOpen(true);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const onSearchChange = (val: string) => {
    setSearchQuery(val);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => runSearch(val), 500);
  };

  const pickSearchResult = (r: SearchResult) => {
    setSearchPin(r);
    setSearchQuery(r.name);
    setSearchOpen(false);
    setFlyToCoord([r.lat, r.lng]);
    setTimeout(() => setFlyToCoord(null), 500);
  };

  // ── Đẩy dữ liệu lên Cardano Blockchain (Module 3) ────────────
  const handlePushToCardano = async (event: SensorEvent) => {
    if (!connected || !name) {
      alert('Vui lòng kết nối ví Eternl trước!');
      return;
    }
    setLoading(true);
    setTxHash('');
    setTxStatus('⏳ Đang xây dựng giao dịch...');

    try {
      const coreWallet = await BrowserWallet.enable(name);
      const myAddress  = await coreWallet.getChangeAddress();

      if (!myAddress) throw new Error('Không lấy được địa chỉ ví.');

      const metadata = {
        project:  'Decentralized Edge-AI Traffic Grid',
        module:   'AI Vision Node',
        data: {
          lat:             event.lat,
          lng:             event.lng,
          type:            event.type,
          confidence:      event.confidence,
          timestamp:       event.timestamp,
          device_id:       event.device_id,
          consensus_count: event.consensusCount,
        },
      };

      // Nếu đã cấu hình Blockfrost API key (NEXT_PUBLIC_BLOCKFROST_API_KEY), dùng làm fetcher
      // để lấy protocol parameters đáng tin cậy hơn — giảm lỗi build tx khi deploy thật.
      const tx = blockfrostKey
        ? new Transaction({ initiator: coreWallet, fetcher: new BlockfrostProvider(blockfrostKey) })
        : new Transaction({ initiator: coreWallet });

      tx.setChangeAddress(myAddress);
      tx.sendLovelace(myAddress, '1000000');
      tx.setMetadata(2026, metadata);

      setTxStatus('🔐 Đang ký giao dịch — vui lòng xác nhận trên ví Eternl...');
      const unsignedTx = await tx.build();
      const signedTx   = await coreWallet.signTx(unsignedTx);
      const hash       = await coreWallet.submitTx(signedTx);

      setTxHash(hash);
      setTxStatus('✅ Giao dịch thành công!');

      await fetch('/api/blockchain-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: event.id, tx_hash: hash }),
      });

      await fetchEvents();

    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Lỗi không xác định';
      console.error('Blockchain error:', error);
      setTxStatus(`❌ Thất bại: ${errMsg}`);
      alert(`Giao dịch thất bại:\n${errMsg}`);
    } finally {
      setLoading(false);
    }
  };

  if (!isMounted) return null;

  const filteredEvents = filter === 'ALL' ? events : events.filter(e => e.type === filter);
  const sidebarLeft = sidebarCollapsed ? 16 : 412;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      {/* ── BẢN ĐỒ (fullscreen background) ── */}
      <MapComponent
        events={filteredEvents}
        selectedEvent={selectedEvent}
        onSelectEvent={setSelectedEvent}
        flyToCoord={flyToCoord}
        sidebarCollapsed={sidebarCollapsed}
        searchPin={searchPin}
      />

      {/* ── THANH TÌM KIẾM + BỘ LỌC LOẠI SỰ CỐ ── */}
      <div style={{
        position: 'absolute', top: 16, left: sidebarLeft, right: 16, zIndex: 150,
        display: 'flex', flexWrap: 'wrap', gap: 10,
        transition: 'left 0.3s cubic-bezier(0.4,0,0.2,1)',
      }}>
        <div style={{ position: 'relative', flex: '1 1 280px', minWidth: 220 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#fff', borderRadius: 14, padding: '0 14px',
            height: 46, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', border: '1px solid #e2e8f0',
          }}>
            <span style={{ color: '#94a3b8', fontSize: '0.95rem' }}>🔍</span>
            <input
              value={searchQuery}
              onChange={e => onSearchChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch(searchQuery); }}
              onFocus={() => { if (searchResults.length) setSearchOpen(true); }}
              placeholder="Tìm kiếm vị trí, tuyến đường tại Hà Nội..."
              style={{ flex: 1, border: 'none', outline: 'none', fontSize: '0.85rem', color: '#1e293b', background: 'transparent' }}
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchOpen(false); setSearchPin(null); }}
                style={{ border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '0.95rem' }}
                title="Xoá tìm kiếm"
              >✕</button>
            )}
          </div>

          {searchOpen && (searchLoading || searchResults.length > 0) && (
            <div style={{
              position: 'absolute', top: 52, left: 0, right: 0,
              background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)', overflow: 'hidden', zIndex: 160,
            }}>
              {searchLoading ? (
                <div style={{ padding: '10px 14px', fontSize: '0.78rem', color: '#94a3b8' }}>Đang tìm...</div>
              ) : searchResults.length === 0 ? (
                <div style={{ padding: '10px 14px', fontSize: '0.78rem', color: '#94a3b8' }}>Không tìm thấy địa điểm trong khu vực Hà Nội</div>
              ) : (
                searchResults.map((r, i) => (
                  <div
                    key={i}
                    onClick={() => pickSearchResult(r)}
                    style={{
                      padding: '9px 14px', fontSize: '0.78rem', color: '#334155',
                      cursor: 'pointer', borderBottom: i < searchResults.length - 1 ? '1px solid #f1f5f9' : 'none',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    📍 {r.name}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Bộ lọc loại sự cố */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FilterChip active={filter === 'ALL'} onClick={() => setFilter('ALL')} icon="🗺" label="Tất cả" dark />
          {INCIDENT_TYPE_ORDER.map(key => (
            <FilterChip
              key={key}
              active={filter === key}
              onClick={() => setFilter(key)}
              icon={INCIDENT_TYPES[key].icon}
              label={CHIP_LABEL[key]}
            />
          ))}
        </div>
      </div>

      {/* ── SIDEBAR ── */}
      <div style={{
        position: 'absolute', top: 16, left: 16, bottom: 16,
        width: 380, zIndex: 200,
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 20,
        boxShadow: '0 8px 24px rgba(0,0,0,0.09)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        transform: sidebarCollapsed ? 'translateX(-400px)' : 'translateX(0)',
      }}>

        {/* Header */}
        <div style={{ padding: '16px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, background: 'linear-gradient(135deg,#6366f1,#0284c7)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: 13, flexShrink: 0 }}>UTC</div>
            <div>
              <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#1e293b', letterSpacing: -0.5 }}>
                AI TRAFFIC <span style={{ color: '#f97316' }}>UTC</span>
              </div>
              <div style={{ fontSize: '0.65rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>
                Decentralized Edge-AI Grid
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(16,185,129,0.1)', padding: '4px 10px', borderRadius: 30, border: '1px solid rgba(16,185,129,0.2)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'statusPulse 1.8s infinite' }} />
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#10b981', letterSpacing: 0.5 }}>LIVE</span>
          </div>
        </div>

        {/* Mạng đồng thuận / Blockfrost */}
        <div style={{ padding: '10px 20px', display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.66rem', fontWeight: 700, color: '#475569', background: '#f1f5f9', padding: '4px 9px', borderRadius: 8 }}>
            🛡 Mạng đồng thuận: <span style={{ color: '#0284c7' }}>Cardano Preprod Testnet</span>
          </span>
          <span style={{
            fontSize: '0.62rem', fontWeight: 700, padding: '4px 9px', borderRadius: 8,
            color: blockfrostKey ? '#4338ca' : '#94a3b8',
            background: blockfrostKey ? '#eef2ff' : '#f1f5f9',
            border: blockfrostKey ? '1px solid #c7d2fe' : '1px solid #e2e8f0',
          }}>
            ⛓ Blockfrost API {blockfrostKey ? '· đã kết nối' : '· chưa cấu hình'}
          </span>
        </div>

        {/* Wallet Banner */}
        <div style={{ padding: '10px 20px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          {connected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.78rem', color: '#15803d', fontWeight: 700 }}>⛓ Ví {name} đã kết nối</span>
              <button onClick={() => disconnect()} style={{ fontSize: '0.7rem', background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600 }}>
                Ngắt kết nối
              </button>
            </div>
          ) : (
            <button
              onClick={() => connect('eternl')}
              disabled={connecting}
              style={{ width: '100%', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 10, padding: '8px 0', fontWeight: 700, fontSize: '0.8rem', cursor: connecting ? 'wait' : 'pointer', opacity: connecting ? 0.7 : 1 }}
            >
              {connecting ? '⏳ Đang gọi ví...' : '🔗 Kết nối ví Eternl để đóng dấu Blockchain'}
            </button>
          )}
        </div>

        {/* Stats — 4 thẻ */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '12px 16px', background: '#fff', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          {[
            { label: 'Tổng sự cố phát hiện', value: stats.total, color: '#ef4444', bg: '#fff5f5' },
            { label: 'Đã đồng thuận đám đông', value: stats.consensusCount, color: '#10b981', bg: '#f0fdf4' },
            { label: 'Edge Node Active', value: stats.activeEdgeNodes, color: '#6366f1', bg: '#eef2ff' },
            { label: 'Độ tin cậy TB mạng', value: `${stats.avgTrustPercent}%`, color: '#f59e0b', bg: '#fff7ed' },
          ].map(s => (
            <div key={s.label} style={{ background: s.bg, borderRadius: 10, padding: '8px 10px', border: `1px solid ${s.color}22` }}>
              <div style={{ fontSize: '0.58rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.2, lineHeight: 1.3 }}>{s.label}</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 800, color: s.color, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.2 }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', background: '#f8fafc', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          {(['feed', 'ledger'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1, border: 'none', background: activeTab === tab ? '#fff' : 'transparent',
                padding: '10px 6px', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer',
                color: activeTab === tab ? '#0284c7' : '#64748b',
                borderBottom: activeTab === tab ? '2px solid #0284c7' : '2px solid transparent',
              }}
            >
              {tab === 'feed' ? '📡 DỮ LIỆU SỰ CỐ (LIVE FEED)' : '📒 SỔ CÁI MINH BẠCH (LEDGER)'}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Tab Feed */}
          {activeTab === 'feed' && (
            <>
              <div style={{ fontSize: '0.66rem', color: '#94a3b8', padding: '0 2px 2px' }}>
                Cập nhật tự động từ các mắt thần di động (Camera/Smartphone)
              </div>

              {filteredEvents.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', fontSize: '0.85rem', textAlign: 'center', gap: 10 }}>
                  <span style={{ fontSize: '2rem' }}>⏳</span>
                  <span>{events.length === 0 ? 'Đang chờ dữ liệu AI...' : 'Không có sự cố khớp bộ lọc'}</span>
                  <span style={{ fontSize: '0.72rem', color: '#cbd5e1' }}>
                    {events.length === 0 ? 'Chạy python detect_and_send.py để bắt đầu' : 'Thử chọn "Tất cả" ở bộ lọc phía trên'}
                  </span>
                </div>
              ) : (
                filteredEvents.map(evt => (
                  <EventCard
                    key={evt.id}
                    event={evt}
                    selected={selectedEvent?.id === evt.id}
                    connected={connected}
                    loading={loading}
                    onSelect={() => {
                      setSelectedEvent(evt);
                      setFlyToCoord([parseFloat(evt.lat), parseFloat(evt.lng)]);
                      setTimeout(() => setFlyToCoord(null), 500);
                    }}
                    onVerify={() => handlePushToCardano(evt)}
                  />
                ))
              )}
            </>
          )}

          {/* Tab Ledger */}
          {activeTab === 'ledger' && (
            <>
              <div style={{ fontSize: '0.66rem', color: '#94a3b8', padding: '0 2px 2px' }}>
                Sự cố đã đóng dấu vĩnh viễn lên Cardano Preprod (CIP-20 metadata)
              </div>

              {txStatus && (
                <div style={{ background: txHash ? '#f0fdf4' : '#fef3c7', border: `1px solid ${txHash ? '#86efac' : '#fde68a'}`, borderRadius: 10, padding: '10px 14px', fontSize: '0.8rem', color: txHash ? '#15803d' : '#92400e', marginBottom: 4 }}>
                  {txStatus}
                  {txHash && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 600, marginBottom: 2 }}>TxHash:</div>
                      <a href={`https://preprod.cardanoscan.io/transaction/${txHash}`} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '0.65rem', color: '#2563eb', wordBreak: 'break-all', fontFamily: "'JetBrains Mono', monospace", display: 'block' }}>
                        {txHash}
                      </a>
                    </div>
                  )}
                </div>
              )}

              {events.filter(e => e.verified).length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', fontSize: '0.82rem', textAlign: 'center', gap: 8 }}>
                  <span style={{ fontSize: '2rem' }}>📒</span>
                  <span>Sổ cái còn trống</span>
                  <span style={{ fontSize: '0.7rem', color: '#cbd5e1' }}>Bấm &quot;Đóng dấu lên Blockchain&quot; trên từng sự cố ở tab Live Feed</span>
                </div>
              ) : (
                events.filter(e => e.verified).map(evt => {
                  const meta = getIncidentMeta(evt.type);
                  return (
                    <div key={evt.id} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 12px', animation: 'slideIn 0.25s ease', fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace" }}>
                      <div style={{ color: '#15803d', fontWeight: 700, marginBottom: 4 }}>✅ {meta.icon} {meta.label} — {evt.timestamp}</div>
                      <div style={{ color: '#64748b', marginBottom: 4 }}>📍 [{evt.lat}, {evt.lng}] | {evt.confidence}</div>
                      <div style={{ color: '#94a3b8', fontSize: '0.65rem', marginBottom: 4 }}>TxHash:</div>
                      <a href={`https://preprod.cardanoscan.io/transaction/${evt.blockchain_tx}`} target="_blank" rel="noopener noreferrer"
                        style={{ color: '#2563eb', wordBreak: 'break-all', display: 'block', fontSize: '0.65rem' }}>
                        {evt.blockchain_tx}
                      </a>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid #f1f5f9', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: '0.78rem', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#1e293b' }}>{clock}</span>
          <span style={{ fontSize: '0.63rem', color: '#cbd5e1' }}>© 2026 Nhóm AI &amp; Blockchain UTC</span>
        </div>
      </div>

      {/* ── NÚT TOGGLE SIDEBAR ── */}
      <button
        onClick={() => setSidebarCollapsed(v => !v)}
        style={{
          position: 'absolute',
          top: '50%',
          left: sidebarCollapsed ? 20 : 404,
          transform: 'translateY(-50%)',
          zIndex: 201,
          width: 28, height: 52,
          background: '#fff',
          border: '1px solid #cbd5e1',
          borderRadius: 8,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '3px 0 8px rgba(0,0,0,0.06)',
          color: '#64748b',
          transition: 'left 0.3s cubic-bezier(0.4,0,0.2,1)',
        }}
        title="Ẩn/Hiện bảng điều khiển"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.3s' }}>
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>
  );
}

// ── Chip bộ lọc loại sự cố ───────────────────────────────────────
function FilterChip({
  active, onClick, icon, label, dark
}: { active: boolean; onClick: () => void; icon: string; label: string; dark?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: 46, padding: '0 16px',
        borderRadius: 14, border: active ? 'none' : '1px solid #e2e8f0',
        background: active ? (dark ? '#0f172a' : '#0284c7') : '#fff',
        color: active ? '#fff' : '#334155',
        fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
        boxShadow: active ? '0 4px 14px rgba(0,0,0,0.18)' : '0 2px 8px rgba(0,0,0,0.05)',
        whiteSpace: 'nowrap',
        transition: 'all 0.15s ease',
      }}
    >
      <span>{icon}</span>{label}
    </button>
  );
}

// ── EventCard component ─────────────────────────────────────────
function EventCard({
  event, selected, connected, loading, onSelect, onVerify
}: {
  event: SensorEvent;
  selected: boolean;
  connected: boolean;
  loading: boolean;
  onSelect: () => void;
  onVerify: () => void;
}) {
  const meta    = getIncidentMeta(event.type);
  const trusted = event.consensus || event.verified;

  return (
    <div
      onClick={onSelect}
      style={{
        background: selected ? '#f0f9ff' : '#fff',
        border: `1px solid ${selected ? '#0284c7' : trusted ? '#bbf7d0' : '#e2e8f0'}`,
        borderRadius: 12,
        padding: '10px 12px',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        transition: 'all 0.18s ease',
        animation: 'slideIn 0.3s ease',
        flexShrink: 0,
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 4, background: trusted ? '#10b981' : '#ef4444', borderRadius: '4px 0 0 4px' }} />

      <div style={{ paddingLeft: 8 }}>
        {/* Dòng 1: loại + thời gian */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ background: trusted ? '#dcfce7' : '#fee2e2', color: trusted ? '#15803d' : '#b91c1c', fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: `1px solid ${trusted ? '#86efac' : '#fca5a5'}`, display: 'flex', alignItems: 'center', gap: 4 }}>
            {meta.icon} {meta.label} <span style={{ opacity: 0.6, fontWeight: 500 }}>🎯</span>
          </span>
          <span style={{ fontSize: '0.66rem', color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace" }}>{event.timestamp}</span>
        </div>

        {/* Dòng 2: toạ độ */}
        <div style={{ fontSize: '0.76rem', fontFamily: "'JetBrains Mono', monospace", color: '#1e293b', fontWeight: 600, marginBottom: 4 }}>
          [{event.lat}, {event.lng}]
        </div>

        {/* Dòng 3: nguồn phát hiện */}
        <div style={{ fontSize: '0.7rem', color: '#64748b', marginBottom: 2 }}>
          Nguồn phát hiện: <span style={{ color: '#6366f1', fontWeight: 600 }}>{event.device_id}</span>
        </div>

        {/* Dòng 4: độ tin cậy + trạng thái */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
            Độ tin cậy: <span style={{ color: trusted ? '#10b981' : '#ef4444', fontWeight: 700 }}>{event.confidence}</span>
          </span>
          <span style={{
            fontSize: '0.64rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6,
            color: trusted ? '#15803d' : '#92400e',
            background: trusted ? '#dcfce7' : '#fef3c7',
          }}>
            {trusted ? 'Đã xác thực' : 'Đang xác minh'}
          </span>
        </div>

        {/* Dòng 5: action button */}
        {!event.verified ? (
          <button
            onClick={e => { e.stopPropagation(); onVerify(); }}
            disabled={!connected || loading}
            style={{
              width: '100%',
              background: !connected ? '#f1f5f9' : 'linear-gradient(135deg,#2563eb,#4f46e5)',
              color: !connected ? '#94a3b8' : '#fff',
              border: 'none', borderRadius: 8,
              padding: '6px 0', fontWeight: 700, fontSize: '0.75rem',
              cursor: !connected || loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? '⏳ Đang xử lý...' : connected ? '⚡ Đóng dấu lên Blockchain' : '🔒 Kết nối ví để đóng dấu'}
          </button>
        ) : (
          <div style={{ fontSize: '0.7rem', color: '#15803d', fontWeight: 600, background: '#f0fdf4', padding: '4px 8px', borderRadius: 6 }}>
            ✅ Đã đóng dấu lên Cardano
            {event.blockchain_tx && (
              <a href={`https://preprod.cardanoscan.io/transaction/${event.blockchain_tx}`}
                target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{ display: 'block', color: '#2563eb', fontSize: '0.65rem', wordBreak: 'break-all', marginTop: 2 }}>
                {event.blockchain_tx.slice(0, 24)}...
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
