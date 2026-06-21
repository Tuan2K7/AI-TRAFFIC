# 🚗 AI Traffic UTC — Decentralized Edge-AI Traffic Grid
**Hệ thống giám sát hạ tầng giao thông phi tập trung — AI + Đồng thuận đám đông + Blockchain (Cardano)**

> Bản này đã được làm lại giao diện theo mẫu "AI Traffic UTC", chuyển sang **GPS thật**
> (không còn toạ độ hardcode làm nguồn chính), và rà soát lại để chạy ổn định khi deploy.
> Phần "Có gì mới" ở cuối file tóm tắt mọi thay đổi.

---

## 🏗 Kiến trúc tổng thể

```
[Camera / Smartphone / GPS rời]
     │
     ▼
┌────────────────────────────────────┐
│  MODULE 1: Python AI (YOLOv8)     │  ← thư mục: python_ai/
│  - Phát hiện sự cố (ổ gà...)     │
│  - Lấy GPS THẬT (xem mục GPS)    │
│  - Gửi HTTP POST → Next.js        │
└──────────────┬─────────────────────┘
               │ JSON qua HTTP POST
               ▼
┌────────────────────────────────────┐
│  MODULE 2: Next.js Dashboard      │  ← thư mục: nextjs_dashboard/
│  - API /api/sensor nhận data      │
│  - Tự tính "Đồng thuận đám đông" │
│  - Bản đồ + tìm kiếm vị trí thật  │
│  - Polling cập nhật real-time     │
└──────────────┬─────────────────────┘
               │ User bấm "Đóng dấu lên Blockchain"
               ▼
┌────────────────────────────────────┐
│  MODULE 3: Blockchain (MeshSDK)   │  ← tích hợp trong Dashboard
│  - Ví Eternl ký giao dịch         │
│  - Metadata CIP-20 lên Cardano    │
│  - TxHash lưu vĩnh viễn (Sổ cái)  │
└────────────────────────────────────┘
```

**Hai lớp "tin cậy" tách biệt** (đúng theo giao diện mẫu):
- **Đồng thuận đám đông** — tự động, miễn phí, nhanh: khi ≥2 Edge Node độc lập (device_id
  khác nhau) cùng báo cùng loại sự cố, trong bán kính ~60m và 15 phút → tự đánh dấu
  "Đã xác thực" (xem `nextjs_dashboard/src/lib/consensus.ts`).
- **Đóng dấu Blockchain** — thủ công, vĩnh viễn, có phí giao dịch nhỏ (testnet, miễn phí qua
  faucet): người dùng bấm nút để ghi cố định 1 sự cố lên Cardano, dùng cho hồ sơ/kiểm toán dài hạn.

---

## 📍 GPS THẬT — không còn toạ độ mặc định làm nguồn chính

`python_ai/modules/gps_provider.py` lấy vị trí theo thứ tự ưu tiên (nguồn nào sẵn sàng & mới nhất thì dùng):

| # | Nguồn | Cần gì | Độ chính xác |
|---|-------|--------|---------------|
| 1 | **GPS rời qua Serial/USB/Bluetooth** (NMEA 0183) | 1 đầu thu GPS USB (vài trăm nghìn đồng) | Cao nhất (m) |
| 2 | **GPS điện thoại qua trình duyệt** (HTTPS Bridge nội bộ) | Chỉ cần điện thoại + cùng WiFi | Cao (m–chục m) |
| 3 | **GPS theo IP** (ip-api.com) | Không cần gì cả | Thấp (cấp thành phố) |
| 4 | Toạ độ mặc định (hardcode Hà Nội) | — | ❌ Chỉ dùng khi 3 nguồn trên đều thất bại, luôn được log rõ |

### Cách dùng GPS điện thoại (khuyến nghị — không cần thiết bị rời)
```bash
python detect_and_send.py --webcam
```
Console sẽ in ra link dạng `https://<ip-LAN-của-máy>:8090`. Mở link này **trên điện thoại**
(cùng mạng WiFi với máy chạy script):
1. Trình duyệt sẽ báo *"Không an toàn"* — đây là bình thường vì dùng chứng chỉ **tự ký**
   (không phải lỗi). Chọn **"Chi tiết / Advanced"** → **"Tiếp tục / Proceed anyway"**.
2. Cho phép quyền **Vị trí (Location)** khi được hỏi.
3. Giữ trang đang mở — vị trí thật của điện thoại sẽ tự động gửi về và được dùng làm GPS
   cho mọi sự cố phát hiện được.

> ⚠️ Vì lý do bảo mật trình duyệt, Geolocation API chỉ chạy trên **HTTPS** hoặc `localhost`
> — đây là lý do cần chứng chỉ tự ký ở trên, không phải lựa chọn tuỳ tiện.

### Cách dùng GPS rời (USB/Bluetooth)
Cắm đầu thu GPS, sau đó:
```bash
python detect_and_send.py --webcam --gps-serial-port COM5      # Windows
python detect_and_send.py --webcam --gps-serial-port /dev/ttyUSB0   # Linux/Mac
# hoặc để trống --gps-serial-port để hệ thống tự dò cổng
```

### Tắt một nguồn (nếu cần)
```bash
python detect_and_send.py --webcam --no-gps-bridge      # chỉ dùng Serial + IP
python detect_and_send.py --webcam --no-gps-serial      # chỉ dùng điện thoại + IP
```

---

## 🚀 HƯỚNG DẪN CHẠY (đọc kỹ thứ tự!)

### Yêu cầu
- Python 3.10+
- Node.js 18+ (đã test với Node 22)
- Ví **Eternl** đã cài trên Chrome (nạp tADA từ faucet Cardano Preprod)

### BƯỚC 1: Chạy Dashboard (Module 2 + 3)
```bash
cd nextjs_dashboard
npm install
cp .env.example .env.local     # (tuỳ chọn) điền Blockfrost API key — xem mục Cấu hình
npm run dev
```
Mở **http://localhost:3000**. Bấm **"Kết nối ví Eternl"** để chuẩn bị sẵn ví.

### BƯỚC 2: Chạy AI Detection (Module 1)

```bash
cd python_ai
pip install -r requirements.txt
```

**Option A — Demo nhanh (không cần camera)** — minh hoạ cả 4 loại sự cố + cơ chế đồng thuận:
```bash
python detect_and_send.py --demo
```

**Option B — File video thực** (đặt `.mp4`/`.gpx` vào `python_ai/sources/`):
```bash
python detect_and_send.py
```

**Option C — Webcam + GPS thật:**
```bash
python detect_and_send.py --webcam
```

### BƯỚC 3: Xác thực lên Blockchain
1. Sự cố xuất hiện trên bản đồ + sidebar (Live Feed).
2. Bấm card → xem chi tiết, hoặc bấm thẳng nút **"⚡ Đóng dấu lên Blockchain"**.
3. Ví Eternl bật lên → xác nhận.
4. TxHash xuất hiện, xem trên [Cardano Preprod Explorer](https://preprod.cardanoscan.io),
   và sự cố chuyển sang tab **Sổ cái minh bạch (Ledger)**.

---

## 🔧 Cấu hình

### Trỏ Python script sang Dashboard đã deploy (không phải localhost)
```bash
python detect_and_send.py --webcam --api-url https://ten-app-cua-ban.vercel.app/api/sensor
# hoặc set biến môi trường:
export DASHBOARD_API_URL="https://ten-app-cua-ban.vercel.app/api/sensor"
```

### Blockfrost API Key (khuyến nghị cho production, không bắt buộc)
1. Tạo project miễn phí tại [blockfrost.io](https://blockfrost.io) → network **Cardano Preprod**.
2. Dán key vào `nextjs_dashboard/.env.local`:
   ```
   NEXT_PUBLIC_BLOCKFROST_API_KEY=preprodXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ```
3. Sidebar sẽ hiện badge **"Blockfrost API · đã kết nối"**.

Không có key, app vẫn hoạt động (dùng trực tiếp ví CIP-30), nhưng có key sẽ giúp việc build
giao dịch lấy protocol parameters ổn định hơn — đỡ lỗi "treo" lúc bấm Đóng dấu Blockchain.

> Biến này có tiền tố `NEXT_PUBLIC_` nên sẽ lộ ra phía client (browser thấy được). Đây là
> key **chỉ đọc dữ liệu** (không thể rút tiền/ký thay), nên rủi ro thấp cho mạng Preprod —
> nhưng đừng tái sử dụng key này cho dự án có dữ liệu nhạy cảm trên Mainnet.

### Đổi tên Edge Node / nhiều Node cùng lúc (test đồng thuận thật)
```bash
python detect_and_send.py --webcam --device-id EdgeNode-HN-021
```
Chạy 2 máy/2 lần với 2 `--device-id` khác nhau, đứng gần cùng vị trí thật → Dashboard sẽ tự
đánh dấu "Đồng thuận đám đông" khi cả hai cùng phát hiện 1 loại sự cố.

---

## 📁 Cấu trúc thư mục

```
DecentralizedTrafficGrid/
├── python_ai/
│   ├── detect_and_send.py         ★ File chạy chính
│   ├── requirements.txt
│   ├── certs/                    ← Chứng chỉ tự ký cho GPS Bridge (đã có sẵn)
│   ├── weights/best.pt           ← Model YOLOv8 (đặt tại đây)
│   ├── sources/                  ← File .mp4 / .gpx
│   ├── logs/
│   └── modules/
│       ├── gps_processor.py      ← Đọc GPS từ GPX/metadata video
│       └── gps_provider.py       ★ GPS THẬT: Serial > điện thoại > IP
│
└── nextjs_dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx          ★ Dashboard chính (UI mới)
    │   │   ├── layout.tsx
    │   │   ├── globals.css
    │   │   └── api/
    │   │       ├── sensor/route.ts            ← Nhận data + tính đồng thuận
    │   │       ├── blockchain-status/route.ts ← Cập nhật TxHash
    │   │       └── geocode/route.ts           ★ Proxy tìm kiếm vị trí (Nominatim)
    │   ├── components/
    │   │   ├── MapComponent.tsx
    │   │   └── MeshProviderWrapper.tsx
    │   └── lib/
    │       ├── incidentTypes.ts  ★ 4 loại sự cố dùng chung toàn hệ thống
    │       └── consensus.ts      ★ Thuật toán đồng thuận đám đông + thống kê mạng
    ├── .env.example
    ├── package.json
    └── next.config.ts
```

---

## 🌍 Deploy

### Khuyến nghị: **Vercel** (dễ nhất cho Next.js, miễn phí cho dự án nhỏ)
1. Push code lên GitHub (repo riêng, hoặc chỉ thư mục `nextjs_dashboard/`).
2. Vào [vercel.com](https://vercel.com) → **Add New Project** → chọn repo → Root Directory =
   `nextjs_dashboard`.
3. Thêm biến môi trường `NEXT_PUBLIC_BLOCKFROST_API_KEY` trong phần **Environment Variables**
   nếu có dùng (xem mục Cấu hình ở trên).
4. Deploy — Vercel tự nhận diện Next.js, không cần cấu hình build thêm.
5. Lấy URL được cấp (vd: `https://ai-traffic-utc.vercel.app`), dùng cho `--api-url` ở Module 1.

> ⚠️ Lưu ý quan trọng cho production: dữ liệu sự cố hiện lưu trong **biến nhớ tạm**
> (`global.sensorEvents`). Trên Vercel (serverless), mỗi lần "cold start" có thể làm mất dữ
> liệu cũ. Với demo/đồ án thì không sao (traffic thấp, instance thường giữ "ấm"); nhưng nếu
> cần lưu trữ bền vững thật, nên thay bằng một DB nhẹ (Postgres/SQLite/Upstash Redis) — đây
> là điểm có thể nâng cấp tiếp, mình có thể hỗ trợ nếu bạn cần.

### Thay thế: **Render** (giống URL trong ảnh mẫu bạn gửi)
Phù hợp nếu muốn 1 server luôn-bật (không "ngủ" giữa các request như serverless free tier) —
tránh được vấn đề mất dữ liệu tạm ở trên. Tạo **Web Service** mới, Root Directory =
`nextjs_dashboard`, Build Command = `npm install && npm run build`, Start Command =
`npm run start`.

### Module 1 (Python) — KHÔNG deploy lên Vercel/Render
Script Python chạy ở máy có camera/GPS thật (laptop, Raspberry Pi cạnh đường), gửi dữ liệu
lên Dashboard đã deploy qua `--api-url`. Đây đúng là kiến trúc "Edge-AI" — xử lý ở biên, chỉ
gửi kết quả lên trung tâm.

---

## 🌐 Links hữu ích
- Cardano Preprod Explorer: https://preprod.cardanoscan.io
- Cardano Preprod Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet
- Blockfrost (API key miễn phí): https://blockfrost.io
- MeshSDK Docs: https://meshjs.dev
- YOLOv8 Docs: https://docs.ultralytics.com

---

*© 2026 Nhóm Nghiên Cứu AI & Blockchain — Trường Đại học Giao thông Vận tải (UTC)*
