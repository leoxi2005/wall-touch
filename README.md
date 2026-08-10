# WALL TOUCH

Mặt nước giao thoa phủ 5 tường phòng pentagon (Bali). Người chạm/quẹt tường → LiDAR Hokuyo
→ LiDAR Bridge → OSC → app này → **5 luồng NDI** `DOOR-WALL-1..5` → MadMapper.

- Chạm = một giọt rơi, vòng sóng lan ra thật và chạy vòng quanh phòng.
- Quẹt = kéo theo sóng **và để lại vệt trail** nhô lên như sống núi, tan trong ~7 giây.
- Nhiều người = sóng giao thoa thật, mỗi người một màu.

Cùng tên NDI với **Door Portals** nên MadMapper không phải warp lại — chạy một trong hai app.

```
npm start                             # 10350×1080 (máy show)
DEMO=1 RENDER_SCALE=0.5 npm start     # preview + 3 bàn tay giả
```
`h` HUD · `c` xoá mặt nước · `b` thả giọt · kéo chuột = chạm giả.

**Bridge không phải sửa gì** — preset 12 zone hiện tại đã bắn `/tuongN/pI/x·y·v·id` @30 Hz.

**Windows:** bản `.exe` đã đóng gói sẵn NDI 6.3.2 (x64) bên trong → **không cần cài NDI Runtime**.

Toàn bộ context, bẫy và tham số chỉnh: **[HANDOFF.md](HANDOFF.md)**.
Thử hướng visual khác: mở `preview/looks.html` bằng trình duyệt.
