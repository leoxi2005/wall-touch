# HANDOFF — WALL TOUCH (mặt nước giao thoa, LiDAR → 5 tường NDI, phòng pentagon Bali)

> Mở **session Claude Code MỚI** ở `~/wall-touch`, cho đọc **file này**. Đủ context để làm tiếp.
> Áp dụng **quy tắc tiết kiệm credit** giống Door Portals (mục 8).

---

## 1. Đây là cái gì

Anh em của **Door Portals** (`~/door-portals`), dùng lại **cùng phòng, cùng cảm biến, cùng đường NDI**,
nhưng thay vì 12 cánh cửa thì cả phòng là **một mặt nước duy nhất vẽ bằng đường đồng mức**:

- **Chạm** → một giọt rơi: vòng sóng lan ra thật, chạy vòng quanh phòng, phản xạ ở trần/sàn.
- **Giữ tay** → cứ ~0.5 s bắn thêm một vòng sóng đồng tâm.
- **Quẹt** → kéo theo một vệt sóng (wake) **và để lại VỆT TRAIL**: chỗ tay đi qua nhô lên
  thành sống núi, đường đồng mức ôm quanh vệt đó rồi tan dần trong ~7 giây.
- **Nhiều người** → sóng cộng vào nhau **giao thoa thật** (không phải hiệu ứng vẽ thêm),
  mỗi người một màu, vệt trail giữ đúng màu người đó.

Output: **5 luồng NDI `DOOR-WALL-1..5`** — **trùng tên với Door Portals** nên MadMapper
**không phải warp lại**. ⚠️ Chỉ chạy **một trong hai app** tại một thời điểm.

## 2. Chạy

```
cd ~/wall-touch
npm start                                  # full 10350×1080 (máy show)
DEMO=1 RENDER_SCALE=0.5 npm start          # preview Mac + 3 "bàn tay" giả
NDI_OFF=1 npm start                        # tắt NDI để đo fps thuần
```
Phím: `h` HUD · `c` xoá sạch mặt nước · `b` thả 1 giọt · **kéo chuột = 1 chạm giả**.
Env: `RENDER_SCALE` (hạ cả độ phân giải render lẫn lưới mô phỏng), `NDI_OFF`, `NDI_PBO`,
`NDI_RGBA`, `NDI_IPC=1`, `KIOSK=1`, `SNAP_DIR` + `SNAP_AT`.

**Đo đã có trên M4 Max** (`RENDER_SCALE=0.35`, DEMO): 60 fps render, **30 NDI hình/giây, 0 drop**
trên cả 5 sender (`readback 0.1 · pack 0.8 · ipc 1.3 ms`). Chưa đo ở full 10350×1080 trên máy show.

## 3. 🔑 INPUT — bridge KHÔNG phải sửa gì

Preset LiDAR Bridge hiện tại (`~/Downloads/Very Final - door-portals.json`, bản 12 zone)
**đã bắn sẵn dữ liệu quẹt**, vì nó đang để `format: "slots"`, `normalize: true`, `sendRate: 30`.
Ở chế độ fusion, `emitSurfaceOsc()` (`app/main/main.js:301` bên bridge) gửi mỗi tường một bundle:

```
/tuongN/count      i   số người đang chạm tường N
/tuongN/pI/on      i   1
/tuongN/pI/x       f   0..1 DỌC tường (0 = mép trái)
/tuongN/pI/y       f   0..1 chiều cao, 0 = TRẦN, 1 = SÀN   ← quy ước bridge
/tuongN/pI/v       f   tốc độ m/s (chỉ độ lớn, KHÔNG có hướng)
/tuongN/pI/id      i   track id ổn định
```

**HAI BẪY, ai bỏ qua là hỏng** (đã xử lý trong `src/touch.js`, đọc comment ở đầu file):

1. **`pI` là SỐ Ô, không phải danh tính.** Bridge chỉ đóng gói các track đang sống, nên khi
   người A nhấc tay thì người B lặng lẽ tụt từ `p1` xuống `p0`. Bám nét vẽ theo ô là vệt
   nhảy ngang phòng. Danh tính là **`/pI/id`**, và `id` là **trường CUỐI** của mỗi ô trong
   bundle — nên code chỉ "chốt" một ô khi nhận được `id`, không sớm hơn.
2. **`/pI/v` là số vô hướng.** Muốn sóng có hướng thì phải **tự vi phân vị trí** (30 Hz là thừa đủ);
   `v` của bridge chỉ dùng để đối chiếu/HUD.

Track bị xoá theo **thời gian chờ** (`osc.trackTimeout`, 0.5 s), **không** theo `/count`:
rớt một gói UDP không được phép giết một nét đang vẽ.

Bấm `h` xem HUD: `pkts` phải tăng, `touches/wall` phải khớp số người đang chạm.

## 4. Kiến trúc render (`src/`)

Ảnh cuối = **bản đồ đường đồng mức của MỘT trường độ cao**, ghép từ 3 lớp:

| lớp | ở đâu | độ phân giải | vai trò |
|:--|:--|:--|:--|
| `base` | trong `contourFrag` | full | sóng lừng procedural — phòng vẫn "thở" khi không ai chạm |
| `wave` | `waveStepFrag` | 3067×320 | **phương trình sóng 2D thật**: lan, phản xạ, giao thoa |
| `trail` | `trailSplatFrag` | 1/3 lưới sóng | vệt tay đắp lên thành sống núi, phân rã ~7 s |

- `src/glutil.js` — WebGL2 helper (program, FBO ping-pong, blit 1 tam giác).
- `src/waves.js` — điều phối: sub-step sóng, phân rã trail, contour, bloom, composite.
- `src/shaders.js` — toàn bộ GLSL.
- `src/touch.js` — OSC → track (xem mục 3).
- `src/app.js` — walls/crop, tương tác, idle, **NDI out**, HUD, vòng lặp chính.
- `main.js` / `preload.js` / `ndi/` / `osc/` — **bê nguyên từ Door Portals**, đã chạy thật.

Không dùng three.js → **miễn nhiễm cái bẫy `three/examples` bị electron-builder cắt khỏi asar**
đã làm Door Portals đen màn hình ở v1.0.3.

## 5. ⚠️ 5 BẪY ĐÃ MẮC / ĐÃ XỬ — đừng lặp lại

1. **PHÒNG NỐI VÒNG KÍN.** 5 tường khép thành ngũ giác nên `uv.x = 1` **chính là** `uv.x = 0`.
   Mọi texture mô phỏng để `REPEAT` trên S; mọi khoảng cách theo x phải `p.x -= round(p.x)`
   (đi đường ngắn); và **trường procedural phải TUẦN HOÀN**: tần số theo x là bội nguyên của
   `TAU/uAspect`, noise dùng `fbmP()` với chu kỳ nguyên (octave nhân đúng `2.0`, không phải `2.03`).
   Viết hằng số tuỳ hứng ở đây là **có một vết sẹo dọc ngay chỗ khách đi qua**.
   **Cách kiểm bằng số** (khỏi soi mắt): so cột đầu với cột cuối của khung hình, đối chiếu với
   phân bố chênh lệch giữa các cột kề nhau — hiện đang ở **phân vị 90**, tức liền mạch.
2. **KHÔNG ĐƯỢC CÓ DẤU BACKTICK trong `src/shaders.js`.** GLSL nằm trong template literal JS,
   một dấu backtick trong *comment* cũng đóng chuỗi → app chết lúc load với
   `SyntaxError: Unexpected identifier` **trỏ vào comment, không trỏ vào shader**. Đã dính 1 lần.
3. **Bộ giải sóng nổ nếu `k` quá lớn.** Sơ đồ hiện (explicit) chỉ ổn định tới Courant ~0.7
   (`k ≈ 0.5`). Muốn sóng chạy nhanh hơn thì **tăng `substeps`**, tuyệt đối đừng tăng `k`.
   `dt` cũng bị kẹp `1/240..1/20` trong vòng lặp vì một khung hình kẹt (kéo cửa sổ, GC) đủ để
   đẩy nó qua giới hạn và cả trường biến thành nhiễu trắng.
4. **Màu trail bị bạc trắng** nếu clamp từng kênh màu: kênh mạnh chạm trần trước. Phải tách
   **A = độ cao (có trần)**, **RGB = màu thuần** trộn theo tỉ lệ phần mới. Đã sửa trong `trailSplatFrag`.
5. **Lấy mẫu lưới sóng bằng bilinear thường để lại nếp gấp C0**, và contour biến nếp gấp đó
   thành **đường gãy khúc thấy rõ**. `smooth4()` (4 tap chéo nửa texel) xử lý gần như miễn phí.

Thêm: **cảnh báo `READ-usage buffer ... discarded the shadow copy`** trong log là **bình thường**
— PBO ring cố ý ghi trước khi đọc xong; Door Portals cũng vậy, không phải lỗi.

## 6. Chỉnh cảm giác — `config.json`

| muốn gì | sửa gì |
|:--|:--|
| vệt trail đậm/nhạt hơn | `waves.trailRate`, trần `waves.trailCap` |
| vệt ở lại lâu hơn | `waves.trailHold` (giây, đang 7.0) |
| sóng lan nhanh hơn | **`waves.substeps`** (đừng đụng `k`) |
| sóng tắt nhanh/chậm | `waves.damping` (mỗi sub-step) |
| giọt mạnh hơn khi chạm | `waves.dropAmp`; nhịp vòng khi giữ tay: `ringAmp`/`ringInterval` |
| quẹt tạo sóng mạnh hơn | `waves.wakeAmp` |
| nhiều/ít đường đồng mức | `waves.contours` (đang 26), đường đậm mỗi `majorEvery` |
| nền tĩnh động hơn | `waves.baseAmp` |
| màu / độ sáng | `look.lineCold`, `look.lineHot`, `look.exposure`, `look.bloomStrength` |
| bao lâu thì tự thả giọt | `idle.afterSeconds` / `intervalSeconds` |

Số đo tường lấy từ `config.json → walls` (giống Door Portals) — đổi `px` là crop NDI tự theo.

## 7. Còn nợ

1. **Chưa chạy thử với LiDAR thật.** Cần: bật bridge (preset cũ, không sửa) → `npm start` →
   bấm `h`, xem `pkts` tăng và `touches/wall` đúng → chạm cửa **trái tường 2** xem vệt hiện
   bên trái hay phải (nếu ngược thì trục +x của sensor đó lật — xử ở bridge, không sửa app).
2. **Chưa đo ở full 10350×1080 trên máy show.** Contour là shader full-res, cần xem fps thật.
   Nếu thiếu: hạ `waves.substeps` hoặc `look.bloomIters` trước, đừng hạ độ phân giải render.
3. **Chưa đóng gói** (`npm run build:mac` / CI Windows). Windows cần build trên máy Windows vì
   `grandiose` không cross-build được từ Mac — copy `.github/workflows/release.yml` của
   Door Portals sang, kèm y nguyên các bẫy CI (`windows-2022`, Python 3.11, `softprops` upload).
4. **`npm install` không tải nổi binary Electron** (giải nén hỏng, thiếu `Frameworks`). Đã vá bằng
   cách copy `node_modules/electron/dist` + `path.txt` từ `~/door-portals`. Máy mới mà lỗi lại
   thì làm y vậy.
5. Chưa có repo GitHub — mới commit local.

## 8. Quy tắc tiết kiệm credit

Giống Door Portals: **không tự chụp screenshot**. Muốn xem thì
`mkdir -p $SNAP_DIR && SNAP_DIR=… SNAP_AT=7000,13000 DEMO=1 RENDER_SCALE=0.35 npm start`,
cắt dải canvas ra khỏi ảnh cửa sổ (canvas nằm giữa, cao đúng `W*1080/10350`), downscale,
**chỉ đưa 1 ảnh khi cần quyết định**. Gộp nhiều chỉnh vào 1 lần rồi mới render.
`zsh` không có `timeout` → chạy nền rồi `pkill -f "wall-touch/node_modules/electron"`.

## 9. Trang so sánh hướng visual

`preview/looks.html` — mở thẳng bằng trình duyệt, không cần Electron. 3 hướng
(sóng giao thoa / màng tế bào / sợi từ trường), rê chuột để giả làm tay, có nút xem
1 tường hay cả 5 tường. **Đã chốt hướng 1.** Giữ file lại để sau này cần thử hướng khác
thì sửa ở đây trước — rẻ hơn sửa cả app nhiều.
