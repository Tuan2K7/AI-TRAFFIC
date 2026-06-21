"""
╔══════════════════════════════════════════════════════════════════╗
║   Module 1: AI Vision Node — Decentralized Traffic Grid         ║
║   Phát hiện ổ gà qua YOLOv8, gửi HTTP POST → Next.js API       ║
║   Hỗ trợ 3 chế độ:                                             ║
║     python detect_and_send.py          → xử lý file video       ║
║     python detect_and_send.py --webcam → webcam thực            ║
║     python detect_and_send.py --demo   → giả lập (không cần AI) ║
║                                                                    ║
║   GPS: ưu tiên GPS Serial/USB rời > GPS điện thoại (HTTPS        ║
║   Bridge) > GPS theo IP > toạ độ mặc định (chỉ khi 3 nguồn       ║
║   trên đều không khả dụng). Xem modules/gps_provider.py          ║
╚══════════════════════════════════════════════════════════════════╝
"""
import argparse
import json
import math
import os
import sys
import time
from datetime import datetime
from threading import Thread, Lock

import cv2
import numpy as np
import requests

from modules.gps_provider import RealGPSProvider

# ── Đường dẫn gốc ──────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Cấu hình hệ thống ──────────────────────────────────────────
YOLO_WEIGHTS    = os.path.join(BASE_DIR, "weights", "best.pt")
YOLO_IMGSZ      = 320
YOLO_CONF       = 0.25
SOURCES_DIR     = os.path.join(BASE_DIR, "sources")
LOG_DIR_BASE    = os.path.join(BASE_DIR, "logs")

# URL API của Next.js Dashboard (Module 2) — có thể trỏ sang server đã deploy
# qua biến môi trường DASHBOARD_API_URL hoặc cờ --api-url khi chạy thật.
DASHBOARD_API   = os.environ.get("DASHBOARD_API_URL", "http://localhost:3000/api/sensor")

# Chống log trùng lặp
MIN_LOG_INTERVAL_S = 1.5
MIN_LOG_DISTANCE_M = 3.0
PROCESS_EVERY_N    = 2   # bỏ qua mỗi N frame để tăng tốc

# GPS mặc định — CHỈ dùng làm phương án CUỐI CÙNG khi không có nguồn GPS thật nào
# (xem RealGPSProvider trong modules/gps_provider.py — Serial > điện thoại > IP > đây)
DEFAULT_LAT = 21.0285
DEFAULT_LNG = 105.8048
DEVICE_ID   = "EdgeNode-HN-001"


# ── Haversine ──────────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2) -> float:
    R = 6_371_000
    phi1, lam1 = math.radians(lat1), math.radians(lon1)
    phi2, lam2 = math.radians(lat2), math.radians(lon2)
    dphi = phi2 - phi1
    dlam = lam2 - lam1
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


# ── Gửi dữ liệu lên Dashboard ─────────────────────────────────
def send_to_dashboard(event_data: dict):
    """Gửi HTTP POST tới Module 2 (Next.js API /api/sensor)."""
    try:
        resp = requests.post(DASHBOARD_API, json=event_data, timeout=3)
        if resp.status_code == 200:
            print(f"  ✅ Đã gửi lên Dashboard: {resp.json().get('message','OK')}")
        else:
            print(f"  ⚠ Dashboard trả về HTTP {resp.status_code}")
    except requests.exceptions.ConnectionError:
        print(f"  ⚠ Không kết nối được Dashboard tại {DASHBOARD_API} (Next.js chưa chạy?)")
    except Exception as e:
        print(f"  ⚠ Lỗi gửi dữ liệu: {e}")


# ── Đóng gói sự kiện sự cố ────────────────────────────────────
def build_event(lat: float, lng: float, confidence: float, device_id: str = DEVICE_ID,
                 defect_type: str = "O_GA") -> dict:
    return {
        "lat":        f"{lat:.6f}",
        "lng":        f"{lng:.6f}",
        "type":       defect_type,
        "confidence": f"{confidence * 100:.1f}%",
        "timestamp":  datetime.now().strftime("%H:%M:%S %d/%m/%Y"),
        "device_id":  device_id,
    }


# ═══════════════════════════════════════════════════════════════
# CHẾ ĐỘ 1: XỬ LÝ FILE VIDEO (kết hợp từ AI_TRAFFIC_UTC)
# ═══════════════════════════════════════════════════════════════
def run_video_mode(model):
    from modules.gps_processor import load_gps_from_gpx, extract_gps_from_video, interpolate_gps

    if not os.path.isdir(SOURCES_DIR):
        print(f"❌ Không tìm thấy thư mục '{SOURCES_DIR}'.")
        print(f"   → Tạo thư mục và đặt file .mp4 vào đó:")
        print(f"   mkdir python_ai/sources && cp your_video.mp4 python_ai/sources/")
        sys.exit(1)

    video_files = sorted([f for f in os.listdir(SOURCES_DIR) if f.lower().endswith(".mp4")])
    if not video_files:
        print(f"❌ Không có file .mp4 nào trong '{SOURCES_DIR}'.")
        sys.exit(1)

    for video_file in video_files:
        video_name = os.path.splitext(video_file)[0]
        video_path = os.path.join(SOURCES_DIR, video_file)
        gpx_path   = os.path.join(SOURCES_DIR, f"{video_name}.gpx")

        print(f"\n{'='*56}")
        print(f"🎬 XỬ LÝ VIDEO : {video_name}")
        print(f"{'='*56}")

        # GPS
        try:
            if os.path.exists(gpx_path):
                gps_track = load_gps_from_gpx(gpx_path)
            else:
                gps_track = extract_gps_from_video(video_path)
            if not gps_track:
                print("  ℹ Video không có GPS track (GPX/metadata) → thử lấy vị trí THẬT theo IP...")
                from modules.gps_provider import fetch_ip_location
                ip_loc = fetch_ip_location()
                if ip_loc:
                    print(f"  🛰 Dùng GPS ước lượng theo IP: {ip_loc['lat']:.4f}, {ip_loc['lon']:.4f} ({ip_loc['label']})")
                    gps_track = [{"time_s": 0, "lat": ip_loc["lat"], "lon": ip_loc["lon"], "speed": 0.0}]
                else:
                    print("  ⚠ KHÔNG có GPS thật nào khả dụng → dùng toạ độ MẶC ĐỊNH (Hà Nội)")
                    gps_track = [{"time_s": 0, "lat": DEFAULT_LAT, "lon": DEFAULT_LNG, "speed": 0.0}]
        except Exception as e:
            print(f"⚠ Lỗi GPS: {e} → dùng toạ độ mặc định")
            gps_track = [{"time_s": 0, "lat": DEFAULT_LAT, "lon": DEFAULT_LNG, "speed": 0.0}]

        # Log dir
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        log_dir    = os.path.join(LOG_DIR_BASE, f"{video_name}_{session_id}")
        os.makedirs(log_dir, exist_ok=True)
        json_file  = os.path.join(log_dir, "pothole_events.json")
        json_events = []

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"❌ Không mở được video: {video_path}")
            continue

        fps_vid     = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_f     = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        print(f"📹 {fps_vid:.1f} FPS | {total_f} frames | Gửi kết quả → {DASHBOARD_API}\n")

        last_log_t  = -999.0
        last_pos    = None
        pothole_cnt = 0
        frame_idx   = 0

        cv2.namedWindow(video_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(video_name, 960, 540)

        while cap.isOpened():
            success, frame = cap.read()
            if not success:
                break

            if frame_idx % PROCESS_EVERY_N != 0:
                frame_idx += 1
                continue

            t0 = time.perf_counter()
            results = model(frame, stream=True, imgsz=YOLO_IMGSZ, conf=YOLO_CONF)
            annotated = frame
            pothole_here = False
            max_conf = 0.0

            for r in results:
                annotated = r.plot()
                if r.boxes is not None and len(r.boxes) > 0:
                    pothole_here = True
                    max_conf = float(r.boxes.conf.max())

            if pothole_here:
                t_s = frame_idx / fps_vid
                gps = interpolate_gps(gps_track, t_s)
                time_ok = (t_s - last_log_t) >= MIN_LOG_INTERVAL_S
                dist_ok = (not last_pos) or haversine(gps["lat"], gps["lon"], *last_pos) >= MIN_LOG_DISTANCE_M

                if time_ok and dist_ok:
                    pothole_cnt += 1
                    last_log_t  = t_s
                    last_pos    = (gps["lat"], gps["lon"])
                    event_data  = build_event(gps["lat"], gps["lon"], max_conf)
                    json_events.append(event_data)

                    print(f"🕳 PHÁT HIỆN Ổ GÀ — Frame {frame_idx}:")
                    print(json.dumps(event_data, indent=2, ensure_ascii=False))
                    # Gửi sang Dashboard trong thread riêng để không chặn video
                    Thread(target=send_to_dashboard, args=(event_data,), daemon=True).start()

            elapsed = time.perf_counter() - t0
            fps_disp = int(1 / elapsed) if elapsed > 0 else 999
            color = (0, 0, 255) if pothole_here else (0, 255, 0)
            cv2.putText(annotated, f"File: {video_name}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)
            cv2.putText(annotated, f"FPS: {fps_disp}", (20, 75), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.putText(annotated, f"Potholes: {pothole_cnt}", (20, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
            cv2.imshow(video_name, annotated)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
            frame_idx += 1

        cap.release()
        cv2.destroyWindow(video_name)

        if json_events:
            with open(json_file, "w", encoding="utf-8") as f:
                json.dump(json_events, f, ensure_ascii=False, indent=4)
            print(f"\n✅ Xuất {len(json_events)} sự kiện → {json_file}")

    cv2.destroyAllWindows()


# ═══════════════════════════════════════════════════════════════
# CHẾ ĐỘ 2: WEBCAM THỰC (kết hợp từ AIMOBILE)
# ═══════════════════════════════════════════════════════════════
def run_webcam_mode(model, gps_serial_port=None, gps_bridge_port=8090,
                     enable_gps_serial=True, enable_gps_bridge=True, enable_gps_os=True, device_id=DEVICE_ID):
    print("\n🎥 CHẾ ĐỘ WEBCAM — Nhấn 'q' để thoát\n")
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("❌ Không mở được webcam (index 0)")
        sys.exit(1)

    gps_provider = RealGPSProvider(
        serial_port=gps_serial_port,
        bridge_port=gps_bridge_port,
        enable_serial=enable_gps_serial,
        enable_bridge=enable_gps_bridge,
        enable_os_location=enable_gps_os,
    )
    gps_provider.start()

    last_log_t   = 0.0
    cnt          = 0
    warned_no_gps = False

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            results = model(frame, imgsz=YOLO_IMGSZ, conf=YOLO_CONF, verbose=False)
            annotated = frame
            pothole_here = False
            max_conf = 0.0

            if results:
                r = results[0]
                annotated = r.plot()
                if r.boxes is not None and len(r.boxes) > 0:
                    pothole_here = True
                    max_conf = float(r.boxes.conf.max())

            # Lấy GPS THẬT mới nhất (Serial > điện thoại > IP). None nếu chưa có nguồn nào sẵn sàng.
            fix = gps_provider.get_current()
            if fix:
                lat, lng, gps_source = fix["lat"], fix["lng"], fix["source"]
                warned_no_gps = False
            else:
                lat, lng, gps_source = DEFAULT_LAT, DEFAULT_LNG, "default-hardcode"
                if not warned_no_gps:
                    print("  ⚠ CHƯA CÓ GPS THẬT NÀO KHẢ DỤNG — đang dùng toạ độ MẶC ĐỊNH tạm thời.")
                    print("    (Cắm GPS USB, hoặc mở GPS Bridge điện thoại ở trên, hoặc đợi GPS theo IP)")
                    warned_no_gps = True

            if pothole_here:
                now = time.monotonic()
                if now - last_log_t >= MIN_LOG_INTERVAL_S:
                    last_log_t = now
                    cnt += 1
                    event_data = build_event(lat, lng, max_conf, device_id=device_id)
                    event_data["gps_source"] = gps_source  # chỉ để log/debug, không bắt buộc ở backend

                    print(f"🕳 PHÁT HIỆN #{cnt} — WEBCAM (GPS: {gps_source}):")
                    print(json.dumps(event_data, indent=2, ensure_ascii=False))
                    Thread(target=send_to_dashboard, args=(event_data,), daemon=True).start()

            color = (0, 0, 255) if pothole_here else (0, 255, 0)
            cv2.putText(annotated, f"POTHOLE: {cnt}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
            cv2.putText(annotated, f"GPS [{gps_source}]: {lat:.5f}, {lng:.5f}", (20, 75),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 2)
            cv2.imshow("YOLOv8 Webcam", annotated)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    finally:
        gps_provider.stop()
        cap.release()
        cv2.destroyAllWindows()


# ═══════════════════════════════════════════════════════════════
# CHẾ ĐỘ 3: GIẢ LẬP (demo — không cần YOLO / webcam)
# ═══════════════════════════════════════════════════════════════
# Mỗi mục: (lat, lng, confidence, loại sự cố, device_id)
# 2 dòng đầu CÙNG vị trí gần nhau + CÙNG loại, nhưng 2 device_id khác nhau
# → minh hoạ cơ chế "Đồng thuận đám đông" (cần ≥2 Edge Node độc lập xác nhận).
DEMO_EVENTS = [
    (21.028500, 105.804800, 0.96, "O_GA",          "EdgeNode-HN-010"),
    (21.028551, 105.804843, 0.83, "O_GA",          "EdgeNode-HN-011"),  # cùng ổ gà → đồng thuận
    (21.035000, 105.812000, 0.88, "VET_LUN",       "EdgeNode-HN-012"),
    (21.021000, 105.798000, 0.79, "NGAP_NUOC",     "EdgeNode-HN-013"),
    (21.044200, 105.823400, 0.91, "NAP_CONG_HONG", "EdgeNode-HN-014"),
    (21.013300, 105.819900, 0.60, "NAP_CONG_HONG", "EdgeNode-HN-015"),
]


def run_demo_mode():
    print("\n🤖 CHẾ ĐỘ GIẢ LẬP — gửi sự kiện mẫu đa loại sự cố + đa Edge Node (không cần camera/AI)\n")
    print("   (2 sự kiện ổ gà đầu tiên ở gần nhau, từ 2 node khác nhau → sẽ tự ĐỒNG THUẬN trên Dashboard)\n")
    for i, (lat, lng, conf, defect_type, device_id) in enumerate(DEMO_EVENTS, 1):
        event_data = build_event(lat, lng, conf, device_id=device_id, defect_type=defect_type)
        print(f"[{i}/{len(DEMO_EVENTS)}] 🕳 Phát hiện giả lập ({defect_type}) từ {device_id}:")
        print(json.dumps(event_data, indent=2, ensure_ascii=False))
        send_to_dashboard(event_data)
        time.sleep(2)
    print("\n✅ Demo hoàn thành — kiểm tra Dashboard tại http://localhost:3000")


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════
def main():
    global DASHBOARD_API
    parser = argparse.ArgumentParser(description="Decentralized Edge-AI Traffic Grid — Module 1")
    parser.add_argument("--webcam", action="store_true", help="Dùng webcam thực")
    parser.add_argument("--demo",   action="store_true", help="Chế độ giả lập (không cần AI/camera)")
    parser.add_argument("--device-id", default=DEVICE_ID, help=f"ID của Edge Node này (mặc định: {DEVICE_ID})")
    parser.add_argument("--gps-serial-port", default=None,
                         help="Cổng Serial của GPS rời (vd: COM5 / /dev/ttyUSB0). Bỏ trống để tự dò.")
    parser.add_argument("--gps-bridge-port", type=int, default=8090,
                         help="Cổng chạy GPS Bridge cho điện thoại qua HTTPS (mặc định 8090)")
    parser.add_argument("--no-gps-serial", action="store_true", help="Tắt nguồn GPS Serial/USB rời")
    parser.add_argument("--no-gps-bridge", action="store_true", help="Tắt GPS Bridge điện thoại (HTTPS nội bộ)")
    parser.add_argument("--no-gps-os", action="store_true",
                         help="Tắt định vị của chính hệ điều hành (Windows Location Service / macOS / Termux)")
    parser.add_argument("--api-url", default=None,
                         help=f"URL API Dashboard để gửi dữ liệu (mặc định: {DASHBOARD_API})")
    args = parser.parse_args()

    if args.api_url:
        DASHBOARD_API = args.api_url

    print("╔══════════════════════════════════════════════════════════╗")
    print("║   Decentralized Edge-AI Traffic Grid — Module 1 (AI)    ║")
    print("╚══════════════════════════════════════════════════════════╝\n")

    if args.demo:
        run_demo_mode()
        return

    print("🔄 Đang nạp mô hình YOLOv8...")
    try:
        from ultralytics import YOLO
        if not os.path.exists(YOLO_WEIGHTS):
            print(f"⚠ Không tìm thấy weights tại: {YOLO_WEIGHTS}")
            print("  → Dùng model mặc định YOLOv8n (sẽ tải về tự động)")
            model = YOLO("yolov8n.pt")
        else:
            model = YOLO(YOLO_WEIGHTS)
        # Warm-up
        _ = model(np.zeros((YOLO_IMGSZ, YOLO_IMGSZ, 3), dtype=np.uint8), verbose=False)
        print("✅ Mô hình sẵn sàng!\n")
    except ImportError:
        print("❌ Chưa cài ultralytics. Chạy: pip install ultralytics")
        sys.exit(1)

    if args.webcam:
        run_webcam_mode(
            model,
            gps_serial_port=args.gps_serial_port,
            gps_bridge_port=args.gps_bridge_port,
            enable_gps_serial=not args.no_gps_serial,
            enable_gps_bridge=not args.no_gps_bridge,
            enable_gps_os=not args.no_gps_os,
            device_id=args.device_id,
        )
    else:
        run_video_mode(model)


if __name__ == "__main__":
    main()
