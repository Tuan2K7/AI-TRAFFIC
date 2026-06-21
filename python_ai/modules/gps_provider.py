"""
Module GPS THẬT cho Edge Node — KHÔNG dùng toạ độ hardcode làm nguồn chính.

Thứ tự ưu tiên (nguồn nào sẵn sàng & "tươi" nhất thì dùng):
  1. GPS rời qua cổng Serial/USB/Bluetooth (chuẩn NMEA 0183) — chính xác nhất,
     dùng khi gắn máy thu GPS thật (vd. u-blox, GPS dongle) vào máy chạy script.
  2. GPS của CHÍNH MÁY đang chạy script (Windows Location Service / macOS
     CoreLocation / Linux GeoClue2 / Termux trên Android) — không cần thiết bị
     hay điện thoại phụ nào khác, dùng luôn định vị có sẵn của hệ điều hành.
  3. GPS điện thoại qua trình duyệt (HTTPS Bridge nội bộ) — mở 1 link trên
     điện thoại (cùng WiFi), trình duyệt tự gửi vị trí thật về. Dự phòng khi
     máy chạy script không có/không bật được định vị hệ điều hành.
  4. GPS theo IP (ước lượng vị trí dựa trên mạng Internet) — không cần thiết bị
     gì cả, độ chính xác chỉ ở mức thành phố, dùng làm lưới an toàn cuối cùng.
  5. Toạ độ mặc định (hardcode Hà Nội) — CHỈ dùng khi tất cả nguồn trên đều
     thất bại, và luôn được log rõ ràng để biết hệ thống đang chạy với GPS giả.

Dùng:
    from modules.gps_provider import RealGPSProvider
    gps = RealGPSProvider(bridge_port=8090)
    gps.start()
    ...
    fix = gps.get_current()   # -> {"lat":.., "lng":.., "speed_kmh":.., "source":..} hoặc None
    ...
    gps.stop()
"""

import json
import os
import platform
import socket
import ssl
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread

import requests

try:
    import serial
    import serial.tools.list_ports
    _HAS_SERIAL = True
except ImportError:
    _HAS_SERIAL = False

# Windows Location Service (dùng WinRT qua package winsdk) — chỉ có trên Windows
try:
    import asyncio
    from winsdk.windows.devices.geolocation import Geolocator, PositionAccuracy
    _HAS_WINSDK = True
except ImportError:
    _HAS_WINSDK = False

# macOS CoreLocation (qua pyobjc) — chỉ có trên macOS
try:
    import CoreLocation # type: ignore
    from PyObjCTools import AppHelper # type: ignore # noqa: F401  (đảm bảo pyobjc-framework-Cocoa có sẵn)
    _HAS_CORELOCATION = True
except ImportError:
    _HAS_CORELOCATION = False

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT_DIR    = os.path.join(BASE_DIR, "certs")
CERT_FILE   = os.path.join(CERT_DIR, "gps_bridge_cert.pem")
KEY_FILE    = os.path.join(CERT_DIR, "gps_bridge_key.pem")


SERIAL_FRESH_S      = 5     # GPS serial phải có fix trong 5s gần nhất mới được coi là "đang dùng"
OS_LOCATION_FRESH_S = 20    # Windows/macOS/Linux Location Service — poll thưa hơn (5-10s/lần)
PHONE_FRESH_S       = 15    # GPS điện thoại — trình duyệt gửi thưa hơn (di chuyển/mạng), nới rộng hơn


# ───────────────────────── NMEA parser (tự viết, không phụ thuộc thư viện ngoài) ─────────────────────────
def _nmea_to_decimal(value: str, direction: str):
    if not value:
        return None
    raw = float(value)
    degrees = int(raw // 100)
    minutes = raw - degrees * 100
    decimal = degrees + minutes / 60.0
    if direction in ("S", "W"):
        decimal = -decimal
    return decimal


def parse_nmea_sentence(line: str):
    """Phân tích 1 dòng NMEA 0183 ($GxGGA / $GxRMC). Trả về {'lat','lon','speed_kmh'} hoặc None."""
    line = (line or "").strip()
    if not line.startswith("$") or "*" not in line:
        return None
    body = line.split("*")[0]
    fields = body.split(",")
    if len(fields) < 6:
        return None
    sentence_id = fields[0][-3:]

    try:
        if sentence_id == "GGA":
            lat = _nmea_to_decimal(fields[2], fields[3])
            lon = _nmea_to_decimal(fields[4], fields[5])
            if lat is None or lon is None:
                return None
            return {"lat": lat, "lon": lon, "speed_kmh": None}

        if sentence_id == "RMC" and len(fields) >= 8:
            if fields[2] != "A":  # 'A' = fix hợp lệ, 'V' = invalid
                return None
            lat = _nmea_to_decimal(fields[3], fields[4])
            lon = _nmea_to_decimal(fields[5], fields[6])
            if lat is None or lon is None:
                return None
            speed_knots = float(fields[7]) if fields[7] else 0.0
            return {"lat": lat, "lon": lon, "speed_kmh": speed_knots * 1.852}
    except (ValueError, IndexError):
        return None
    return None


# ───────────────────────── (Lớp dùng chung) GPS của chính máy đang chạy (OS Location Service — ưu tiên #2) ─────────────────────────
def _is_termux() -> bool:
    return os.path.exists("/data/data/com.termux") or "com.termux" in os.environ.get("PREFIX", "")


class _WindowsLocationReader(Thread):
    """Dùng Windows Location Service (WinRT qua winsdk) — định vị bằng WiFi xung quanh,
    không cần chip GPS riêng. Cần: Settings > Privacy & Security > Location > bật
    'Location services' VÀ bật quyền cho 'Desktop apps'."""

    def __init__(self, shared_state: dict, lock: Lock, poll_interval: int = 8):
        super().__init__(daemon=True)
        self._state = shared_state
        self._lock = lock
        self._poll_interval = poll_interval
        self._stop_flag = False

    def run(self):
        if not _HAS_WINSDK:
            return
        print("  📡 Đang dùng Windows Location Service để lấy GPS thật trên chính máy này...")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        geolocator = Geolocator()
        try:
            geolocator.desired_accuracy = PositionAccuracy.HIGH
        except Exception:
            pass

        warned = False
        while not self._stop_flag:
            try:
                pos = loop.run_until_complete(geolocator.get_geoposition_async())
                coord = pos.coordinate
                lat = coord.point.position.latitude
                lon = coord.point.position.longitude
                speed_kmh = (coord.speed or 0.0) * 3.6 if getattr(coord, "speed", None) else 0.0
                with self._lock:
                    self._state["os_location"] = {"lat": lat, "lon": lon, "speed_kmh": speed_kmh, "ts": time.time()}
                warned = False
            except Exception as e:
                if not warned:
                    print(f"  ⚠ Windows Location Service chưa lấy được vị trí: {e}")
                    print("    → Vào Settings > Privacy & Security > Location:")
                    print("       1) Bật 'Location services'")
                    print("       2) Bật quyền truy cập vị trí cho 'Desktop apps'")
                    warned = True
            time.sleep(self._poll_interval)

    def stop(self):
        self._stop_flag = True


class _MacLocationReader(Thread):
    """Dùng macOS CoreLocation (qua pyobjc) — cần cấp quyền vị trí cho Terminal/Python
    tại System Settings > Privacy & Security > Location Services."""

    def __init__(self, shared_state: dict, lock: Lock, poll_interval: int = 8):
        super().__init__(daemon=True)
        self._state = shared_state
        self._lock = lock
        self._poll_interval = poll_interval
        self._stop_flag = False
        self._manager = None

    def run(self):
        if not _HAS_CORELOCATION:
            return
        print("  📡 Đang dùng macOS Location Services để lấy GPS thật trên chính máy này...")
        self._manager = CoreLocation.CLLocationManager.alloc().init()
        self._manager.startUpdatingLocation()
        warned = False
        while not self._stop_flag:
            try:
                loc = self._manager.location()
                if loc is not None:
                    coord = loc.coordinate()
                    with self._lock:
                        self._state["os_location"] = {
                            "lat": coord.latitude, "lon": coord.longitude,
                            "speed_kmh": max(loc.speed(), 0) * 3.6, "ts": time.time(),
                        }
                    warned = False
                elif not warned:
                    print("  ⚠ macOS chưa cấp quyền vị trí cho Terminal/Python.")
                    print("    → System Settings > Privacy & Security > Location Services > bật cho Terminal")
                    warned = True
            except Exception as e:
                if not warned:
                    print(f"  ⚠ macOS Location Services lỗi: {e}")
                    warned = True
            time.sleep(self._poll_interval)

    def stop(self):
        self._stop_flag = True
        if self._manager:
            try:
                self._manager.stopUpdatingLocation()
            except Exception:
                pass


class _TermuxLocationReader(Thread):
    """Khi chạy script TRỰC TIẾP trên điện thoại Android qua Termux — dùng app
    Termux:API (cài thêm từ F-Droid/Play) để lấy GPS thật của chính điện thoại,
    không cần laptop/bridge gì cả."""

    def __init__(self, shared_state: dict, lock: Lock, poll_interval: int = 6):
        super().__init__(daemon=True)
        self._state = shared_state
        self._lock = lock
        self._poll_interval = poll_interval
        self._stop_flag = False

    def run(self):
        print("  📡 Đang dùng Termux:API để lấy GPS thật của điện thoại (cần cài app Termux:API)...")
        warned = False
        while not self._stop_flag:
            try:
                out = subprocess.run(
                    ["termux-location", "-p", "network", "-r", "once"],
                    capture_output=True, text=True, timeout=15,
                )
                data = json.loads(out.stdout)
                with self._lock:
                    self._state["os_location"] = {
                        "lat": data["latitude"], "lon": data["longitude"],
                        "speed_kmh": max(data.get("speed", 0) or 0, 0) * 3.6, "ts": time.time(),
                    }
                warned = False
            except FileNotFoundError:
                if not warned:
                    print("  ⚠ Chưa có lệnh termux-location — cài: pkg install termux-api (và app Termux:API trên điện thoại)")
                    warned = True
                return  # không cần thử lại liên tục nếu thiếu hẳn lệnh
            except Exception as e:
                if not warned:
                    print(f"  ⚠ Termux Location lỗi: {e}")
                    warned = True
            time.sleep(self._poll_interval)

    def stop(self):
        self._stop_flag = True


def _make_os_location_reader(shared_state: dict, lock: Lock):
    """Tự chọn đúng nguồn định vị theo hệ điều hành đang chạy script."""
    system = platform.system()
    if system == "Windows" and _HAS_WINSDK:
        return _WindowsLocationReader(shared_state, lock)
    if system == "Darwin" and _HAS_CORELOCATION:
        return _MacLocationReader(shared_state, lock)
    if system == "Linux" and _is_termux():
        return _TermuxLocationReader(shared_state, lock)
    return None


# ───────────────────────── (Lớp dùng chung) GPS rời qua Serial/USB (NMEA — ưu tiên #1, chính xác nhất) ─────────────────────────
class _SerialGPSReader(Thread):
    def __init__(self, shared_state: dict, lock: Lock, port: str | None = None, baudrate: int = 9600):
        super().__init__(daemon=True)
        self._state = shared_state
        self._lock = lock
        self._port = port
        self._baudrate = baudrate
        self._stop_flag = False
        self._ser = None

    def _autodetect_port(self):
        for candidate in serial.tools.list_ports.comports():
            try:
                test = serial.Serial(candidate.device, self._baudrate, timeout=1)
                for _ in range(20):
                    raw = test.readline().decode("ascii", errors="ignore")
                    if parse_nmea_sentence(raw):
                        test.close()
                        return candidate.device
                test.close()
            except Exception:
                continue
        return None

    def run(self):
        if not _HAS_SERIAL:
            return
        port = self._port or self._autodetect_port()
        if not port:
            print("  ℹ Không tìm thấy thiết bị GPS Serial/USB nào → bỏ qua nguồn này")
            return
        try:
            self._ser = serial.Serial(port, self._baudrate, timeout=1)
            print(f"  📡 Đang đọc GPS THẬT từ thiết bị Serial: {port}")
        except Exception as e:
            print(f"  ⚠ Không mở được cổng {port}: {e}")
            return

        while not self._stop_flag:
            try:
                raw = self._ser.readline().decode("ascii", errors="ignore")
                fix = parse_nmea_sentence(raw)
                if fix:
                    with self._lock:
                        self._state["serial"] = {**fix, "ts": time.time()}
            except Exception:
                time.sleep(0.5)

    def stop(self):
        self._stop_flag = True
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass


# ───────────────────────── (Lớp dùng chung) GPS điện thoại qua HTTPS Bridge (ưu tiên #3) ─────────────────────────
_BRIDGE_HTML = """<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Traffic UTC — GPS Bridge</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;box-sizing:border-box;}
  h1{font-size:1.1rem;margin-bottom:6px;} .sub{color:#94a3b8;font-size:0.8rem;margin-bottom:24px;}
  #status{font-size:1rem;font-weight:700;margin-bottom:10px;}
  #coords{font-family:monospace;font-size:0.85rem;color:#38bdf8;margin-bottom:6px;}
  #count{color:#475569;font-size:0.75rem;}
</style></head>
<body>
  <h1>📡 AI Traffic UTC — GPS Bridge</h1>
  <div class="sub">Giữ trang này đang mở để gửi vị trí thật của điện thoại về Edge Node</div>
  <div id="status">Đang xin quyền truy cập vị trí...</div>
  <div id="coords"></div>
  <div>Đã gửi: <span id="count">0</span> lần</div>
<script>
let n = 0;
function update(pos){
  const c = pos.coords;
  document.getElementById('status').textContent = '🟢 Đang gửi vị trí thật...';
  document.getElementById('coords').textContent =
    'Lat ' + c.latitude.toFixed(6) + '  Lng ' + c.longitude.toFixed(6) + '  (±' + Math.round(c.accuracy) + 'm)';
  fetch('/update', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({lat:c.latitude, lng:c.longitude, accuracy:c.accuracy, speed:c.speed||0})
  }).catch(()=>{});
  n++; document.getElementById('count').textContent = n;
}
function fail(err){ document.getElementById('status').textContent = '🔴 Lỗi GPS: ' + err.message; }
if (navigator.geolocation){
  navigator.geolocation.watchPosition(update, fail, {enableHighAccuracy:true, maximumAge:2000, timeout:10000});
} else {
  document.getElementById('status').textContent = '❌ Trình duyệt này không hỗ trợ Geolocation';
}
</script></body></html>"""


def _make_handler(shared_state: dict, lock: Lock):
    class GpsHandler(BaseHTTPRequestHandler):
        def _send_json(self, payload, code=200):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                body = _BRIDGE_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/status":
                with lock:
                    self._send_json(shared_state.get("phone") or {"message": "chưa có dữ liệu"})
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            if self.path != "/update":
                self.send_response(404)
                self.end_headers()
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length))
                lat, lon = float(data["lat"]), float(data["lng"])
                speed_kmh = float(data.get("speed") or 0) * 3.6  # browser trả m/s
                with lock:
                    shared_state["phone"] = {"lat": lat, "lon": lon, "speed_kmh": speed_kmh, "ts": time.time()}
                self._send_json({"ok": True})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, code=400)

        def log_message(self, fmt, *args):
            pass  # im lặng — tránh rác console mỗi lần điện thoại gửi vị trí

    return GpsHandler


class PhoneGPSBridge:
    def __init__(self, shared_state: dict, lock: Lock, port: int = 8090):
        self._port = port
        self._server = None
        self._handler_cls = _make_handler(shared_state, lock)

    def start(self) -> bool:
        if not (os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)):
            print(f"  ⚠ Thiếu chứng chỉ HTTPS tại {CERT_DIR} → bỏ qua GPS Bridge điện thoại")
            return False
        try:
            self._server = ThreadingHTTPServer(("0.0.0.0", self._port), self._handler_cls)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
            self._server.socket = ctx.wrap_socket(self._server.socket, server_side=True)
        except OSError as e:
            print(f"  ⚠ Không khởi động được GPS Bridge ở cổng {self._port}: {e}")
            return False

        Thread(target=self._server.serve_forever, daemon=True).start()
        return True

    def stop(self):
        if self._server:
            try:
                self._server.shutdown()
            except Exception:
                pass


# ───────────────────────── (Lớp dùng chung) GPS theo IP — dự phòng cuối (ưu tiên #4) ─────────────────────────
def fetch_ip_location():
    """Một lệnh gọi duy nhất lúc khởi động — KHÔNG có giấy phép dùng để theo dõi liên tục."""
    try:
        resp = requests.get("http://ip-api.com/json/?fields=status,lat,lon,city,query", timeout=4)
        data = resp.json()
        if data.get("status") == "success":
            return {
                "lat": data["lat"], "lon": data["lon"], "speed_kmh": 0.0,
                "label": f"{data.get('city', '?')} (qua IP {data.get('query', '?')})",
            }
    except Exception as e:
        print(f"  ⚠ Không lấy được vị trí ước lượng theo IP: {e}")
    return None


def _get_local_ip() -> str:
    """Cách cũ — chỉ trả 1 IP 'đoán' qua route ra Internet. Giữ lại để tương thích,
    nhưng nên dùng _list_candidate_ips() để in đầy đủ lựa chọn cho người dùng tự chọn."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _list_candidate_ips() -> list[str]:
    """Liệt kê TẤT CẢ địa chỉ IPv4 LAN khả dụng (máy có thể có nhiều card mạng:
    WiFi, Ethernet, VPN ảo...). Loại bỏ loopback (127.x) vì điện thoại không bao
    giờ truy cập được địa chỉ đó."""
    candidates: set[str] = set()

    # Cách 1: route ra ngoài (không thực sự gửi packet, chỉ hỏi bảng định tuyến)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127."):
            candidates.add(ip)
    except Exception:
        pass

    # Cách 2: liệt kê toàn bộ IP gắn với hostname máy (bắt được cả khi không có Internet)
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                candidates.add(ip)
    except Exception:
        pass

    return sorted(candidates)


# ───────────────────────── Provider tổng hợp ─────────────────────────
class RealGPSProvider:
    def __init__(self, serial_port: str | None = None, bridge_port: int = 8090,
                 enable_serial: bool = True, enable_bridge: bool = True, enable_os_location: bool = True):
        self._lock = Lock()
        self._state: dict = {}
        self._ip_fallback = None
        self._bridge_port = bridge_port

        self._serial_reader = (
            _SerialGPSReader(self._state, self._lock, port=serial_port)
            if enable_serial and _HAS_SERIAL else None
        )
        self._os_reader = (
            _make_os_location_reader(self._state, self._lock) if enable_os_location else None
        )
        self._bridge = PhoneGPSBridge(self._state, self._lock, port=bridge_port) if enable_bridge else None

    def start(self):
        print("\n📍 KHỞI TẠO NGUỒN GPS THẬT (không dùng toạ độ mặc định làm nguồn chính)")

        if self._serial_reader:
            self._serial_reader.start()
        elif not _HAS_SERIAL:
            print("  ℹ Chưa cài pyserial (pip install pyserial) → bỏ qua nguồn GPS Serial/USB rời")

        if self._os_reader:
            self._os_reader.start()
        else:
            system = platform.system()
            print(f"  ℹ Không có nguồn định vị hệ điều hành khả dụng cho {system} lúc này "
                  "(thiếu thư viện hoặc không hỗ trợ) → dùng GPS điện thoại/IP thay thế")

        bridge_ok = self._bridge.start() if self._bridge else False
        if bridge_ok:
            ips = _list_candidate_ips()
            if not ips:
                print("  ❌ KHÔNG tìm thấy địa chỉ IP mạng LAN nào — điện thoại sẽ KHÔNG vào được link!")
                print("     → Kiểm tra máy này đã kết nối WiFi/LAN chưa, hoặc tự tra IP bằng:")
                print("       Windows: ipconfig   |   Mac/Linux: ifconfig hoặc ip addr")
                print(f"       Rồi tự mở: https://<IP-của-bạn>:{self._bridge_port} trên điện thoại")
            elif len(ips) == 1:
                print(f"  🌐 GPS Bridge điện thoại đã chạy tại: https://{ips[0]}:{self._bridge_port}")
            else:
                print(f"  🌐 GPS Bridge điện thoại đã chạy ở cổng {self._bridge_port}. Máy này có nhiều IP mạng,")
                print("     thử LẦN LƯỢT các link sau trên điện thoại (cùng WiFi) cho đến khi vào được:")
                for ip in ips:
                    print(f"       → https://{ip}:{self._bridge_port}")
            print("     (Chỉ cần dùng nếu Windows Location Service ở trên không lấy được vị trí)")
            print("     1) Điện thoại PHẢI cùng WiFi với máy này (không dùng 4G/5G, không Guest WiFi)")
            print("     2) Trình duyệt báo 'Không an toàn' do chứng chỉ tự ký → chọn 'Chi tiết/Advanced' → 'Tiếp tục/Proceed'")
            print("     3) Cho phép quyền truy cập Vị trí khi được hỏi — vị trí thật sẽ tự gửi về hệ thống")
            print("     4) Nếu vẫn không vào được: tắt Firewall tạm để test, hoặc thử mở chính link này trên")
            print("        trình duyệt của MÁY NÀY trước (không phải điện thoại) để biết lỗi do mạng hay do máy")

        def _bg_ip_lookup():
            self._ip_fallback = fetch_ip_location()
            if self._ip_fallback:
                print(f"  🛰 Đã có GPS dự phòng theo IP: {self._ip_fallback['lat']:.4f}, "
                      f"{self._ip_fallback['lon']:.4f} ({self._ip_fallback['label']})")

        Thread(target=_bg_ip_lookup, daemon=True).start()

    def get_current(self):
        """Trả {'lat','lng','speed_kmh','source'} theo nguồn tươi nhất, hoặc None nếu chưa có gì."""
        now = time.time()
        with self._lock:
            serial_fix = self._state.get("serial")
            os_fix = self._state.get("os_location")
            phone_fix = self._state.get("phone")

        if serial_fix and now - serial_fix["ts"] <= SERIAL_FRESH_S:
            return {"lat": serial_fix["lat"], "lng": serial_fix["lon"],
                    "speed_kmh": serial_fix.get("speed_kmh") or 0.0, "source": "gps-serial"}

        if os_fix and now - os_fix["ts"] <= OS_LOCATION_FRESH_S:
            return {"lat": os_fix["lat"], "lng": os_fix["lon"],
                    "speed_kmh": os_fix.get("speed_kmh") or 0.0, "source": "gps-os-device"}

        if phone_fix and now - phone_fix["ts"] <= PHONE_FRESH_S:
            return {"lat": phone_fix["lat"], "lng": phone_fix["lon"],
                    "speed_kmh": phone_fix.get("speed_kmh") or 0.0, "source": "gps-phone"}

        if self._ip_fallback:
            return {"lat": self._ip_fallback["lat"], "lng": self._ip_fallback["lon"],
                    "speed_kmh": 0.0, "source": "ip-estimate"}

        return None

    def stop(self):
        if self._serial_reader:
            self._serial_reader.stop()
        if self._os_reader:
            self._os_reader.stop()
        if self._bridge:
            self._bridge.stop()
