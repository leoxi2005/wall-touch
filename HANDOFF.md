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

Trên nữa có 3 lớp **element** vẽ đè (không nằm trong trường độ cao):

| element | file | sinh ra khi nào |
|:--|:--|:--|
| **bọt sóng vỗ bờ** | `contourFrag` | bờ biển sáng lên theo biên độ sóng đang đập vào nó |
| **hạt sáng trôi** (motes) | `motes.js` | luôn có; bị **hút và xoáy quanh tay**, sáng bùng lên khi tay lại gần |
| **bong bóng** | `motes.js` | **chỉ khi có người chạm** — nổi lên từ chỗ chạm, lắc lư rồi vỡ |
| **đàn cá** | `life.js` | luôn có, bơi theo đàn; **tán loạn khi tay lại gần** và bình tĩnh lại sau ~2.5 s |
| **san hô** | `life.js` | mọc phân nhánh khi một bàn tay **đứng yên** > 1.1 s (đắp vào chính trường trail) |
| **dòng điện chạy dọc bờ** | `contourFrag` | xung sáng chạy dọc đường bờ biển |

Và `bridgeHands()` trong `app.js`: **hai người đứng gần nhau thì đất của họ nối lại**
thành eo — vật liệu được đắp dọc đường nối hai bàn tay, mạnh dần khi lại gần.

Rồi `contourFrag` dựng ảnh từ trường tổng đó theo 2 tầng:
**tầng khối** (đổ bóng theo độ dốc + dải màu theo độ cao — cái làm nó ra "địa hình có
ánh sáng" thay vì "hình vẽ nét") và **tầng nét** đè lên trên.

- `src/glutil.js` — WebGL2 helper (program, FBO ping-pong, blit 1 tam giác).
- `src/waves.js` — điều phối: sub-step sóng, phân rã trail, contour, bloom, composite.
- `src/shaders.js` — toàn bộ GLSL.
- `src/touch.js` — OSC → track (xem mục 3).
- `src/app.js` — walls/crop, tương tác, idle, **NDI out**, HUD, vòng lặp chính.
- `main.js` / `preload.js` / `ndi/` / `osc/` — **bê nguyên từ Door Portals**, đã chạy thật.

Không dùng three.js → **miễn nhiễm cái bẫy `three/examples` bị electron-builder cắt khỏi asar**
đã làm Door Portals đen màn hình ở v1.0.3.

## 5. ⚠️ BẪY ĐÃ MẮC / ĐÃ XỬ — đừng lặp lại

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
5. **ĐẮP VỆT THEO THỜI GIAN LÀ SAI — phải theo QUÃNG ĐƯỜNG.** Bản đầu đắp
   `trailRate * dt`, nên tay đứng yên xây thành núi còn **tay quẹt nhanh gần như không
   để lại gì** (nó ở mỗi chỗ quá ít thời gian). Ba bàn tay demo đều trôi chậm nên bug
   này sống sót qua mọi lần kiểm — mãi tới khi chủ dự án quẹt chuột thật mới lộ.
   Kèm theo: phải **đóng dấu DỌC đoạn đường** giữa 2 mẫu (`paintStroke`), vì ở 30 Hz một
   bàn tay 2 m/s nhảy xa hơn bán kính dấu → một dấu/mẫu ra nét đứt quãng.
   → **`DEMO` giờ có bàn tay thứ 4 quẹt nhanh ~2 m/s**, giữ nguyên đừng bỏ, nó là cái
   duy nhất bắt được lớp lỗi này.
6. **`look.relief` phải nhân với chiều cao khung hình.** `dFdx` là đạo hàm THEO PIXEL,
   nên cùng một mặt nước sẽ càng phẳng khi render càng to → preview 0.35 và bản chiếu
   thật sẽ khác hẳn nhau. Đã nhân trong `waves.js`.
7. **Specular số mũ cao bắt đúng lưới texel** của lớp sóng độ phân giải thấp → hiện các
   **ô vuông lấp lánh**. Phải nới `smooth4()` lên ±0.9 texel (đạo hàm khuếch đại nếp gấp
   C0 mạnh hơn nhiều so với chính giá trị) và giữ `look.specular` thấp.
8. **Vệt trail phải nổi bằng MÀU, không bằng độ chói.** Bản đầu vẽ nét trên vệt sáng gấp
   đôi nét thường → cháy trắng, nuốt mất mặt nước. Nay cùng độ sáng, chỉ đổi tông.
9. **Lấy mẫu lưới sóng bằng bilinear thường để lại nếp gấp C0**, và contour biến nếp gấp đó
   thành **đường gãy khúc thấy rõ**. `smooth4()` (4 tap chéo nửa texel) xử lý gần như miễn phí.

10. **Đừng ghi bất cứ thứ gì cạnh mã nguồn.** Trong bản đóng gói, mọi thứ trong `files`
   nằm trong `app.asar` **chỉ đọc**. Ghi ra `app.getPath('userData')` và coi nó là lớp
   phủ lên config gốc.
11. **Dọn dẹp track phải theo "key nào xuất hiện trong khung này"**, không phải theo
   "key nào có trong map của tracker". Bản đầu xoá mọi key không thuộc tracker mỗi khung
   — nghĩa là toàn bộ bàn tay DEMO bị xoá trạng thái liên tục, và **bộ đếm giữ-yên của
   hiệu chỉnh không bao giờ tăng quá 0**. Triệu chứng: giữ tay mãi mà không bắt được.
12. **Mỗi dấu đắp là một lượt vẽ TOÀN MÀN HÌNH lên trường trail.** San hô mọc hàng chục
   nhánh cùng lúc và một nét quẹt đắp cả chục dấu mỗi khung — ở full res đó là hàng chục
   triệu pixel/khung cho vài gaussian rộng vài texel. Nay `deposit()` **xếp hàng, gộp 16
   dấu một lượt** (`flushDeposits`). Thêm chỗ đắp mới thì cứ gọi `deposit()` như thường,
   nó tự gộp — nhưng **phải flush trước khâu decay**, không thì dấu bị ghi lên buffer đã
   phân rã rồi mất trắng lúc swap.

Thêm: **cảnh báo `READ-usage buffer ... discarded the shadow copy`** trong log là **bình thường**
— PBO ring cố ý ghi trước khi đọc xong; Door Portals cũng vậy, không phải lỗi.

## 6. Chỉnh cảm giác — `config.json`

| muốn gì | sửa gì |
|:--|:--|
| vệt trail đậm/nhạt hơn | `waves.trailInk` (theo QUÃNG ĐƯỜNG quẹt), trần `waves.trailCap` |
| giữ tay đứng yên đắp nhanh/chậm | `waves.trailDwell` (theo thời gian) |
| vệt nổi cao hơn (nhiều vòng hơn) | `waves.trailGain` |
| vệt sáng/tối hơn | `look.trailGlow` |
| mặt nước nổi khối nhiều/ít | `look.relief`, `look.shade`, `look.ambient` |
| lấp lánh trên đỉnh sóng | `look.specular` |
| tông màu nước (trũng → đỉnh) | `look.rampDeep` / `rampMid` / `rampHigh` |
| vệt ở lại lâu hơn | `waves.trailHold` (giây, đang **2.6**) |
| sóng lan nhanh hơn | **`waves.substeps`** (đừng đụng `k`) |
| sóng tắt nhanh/chậm | `waves.damping` (mỗi sub-step) |
| giọt mạnh hơn khi chạm | `waves.dropAmp`; nhịp vòng khi giữ tay: `ringAmp`/`ringInterval` |
| quẹt tạo sóng mạnh hơn | `waves.wakeAmp` |
| nhiều/ít đường đồng mức | `waves.contours` (đang 26), đường đậm mỗi `majorEvery` |
| nền tĩnh động hơn | `waves.baseAmp` |
| màu / độ sáng | `look.lineCold`, `look.lineHot`, `look.exposure`, `look.bloomStrength` |
| bao lâu thì tự thả giọt | `idle.afterSeconds` / `intervalSeconds` |
| mực nước cao/thấp (nhiều/ít đảo) | `look.seaLevel`, biên độ thở `seaDrift`, nhịp `seaSpeed` |
| bờ biển sáng/tối | `look.coastGlow`; màu đất `look.landColor` |
| đèn quay nhanh/chậm | `look.lightSpin` |
| nối nét khi bridge đổi id | `osc.stitchRadius` (mét-tường), `osc.stitchSeconds` |
| **chạm bị lệch trên một tường** | `walls[i].uScale` / `uOffset` — bấm `k` để đo (mục 7b-bis) |
| bọt vỗ bờ mạnh/nhẹ | `look.foam` |
| hạt sáng: số lượng/độ sáng/lực hút | `motes.count`, `brightness`, `pull`, `swirl`, `reach` |
| bong bóng: nhiều/nhanh/to | `bubbles.rate`, `rise`, `size`, `life` |
| hai người nối đất | `bridge.maxDist` (mét-tường), `bridge.ink` |
| cá: số lượng/đàn/độ nhát | `fish.count`, `shoals`, `fearRadius`, `fear`, `burst` |
| san hô: mọc nhanh/nhiều nhánh | `coral.speed`, `branchChance`, `maxGen`, `ink` |
| bao lâu đứng yên thì mọc san hô | `coral.afterSeconds` |
| xung sáng dọc bờ | `look.shoreCurrent`, `shoreCurrentSpeed` |

Số đo tường lấy từ `config.json → walls` (giống Door Portals) — đổi `px` là crop NDI tự theo.

## 7. Phát hành

- Repo public: **github.com/leoxi2005/wall-touch** (`gh` đang đăng nhập `leoxi2005`).
- **v1.0.0** — macOS `.dmg` build tại máy này, Windows `.exe`/`.zip` do CI build và tự
  đính vào release của tag. Ra bản mới:

```
# sửa code → bump "version" trong package.json
git add -A && git commit -m "..." && git push
npm run build:mac
gh release create v1.0.1 "release/Wall Touch-1.0.1-arm64.dmg#macOS (Apple Silicon) .dmg" \
   --title "Wall Touch v1.0.1" --notes "..."
# → tag tự kích CI Windows, .exe + .zip tự đính vào cùng release
```

- Mac build **chưa ký** → mở lần đầu phải chuột phải → Open.
- **Trước khi phát hành nhớ kiểm bản đóng gói**, đừng tin bản `npm start`:
  `npx electron-builder --mac --dir` rồi chạy
  `SNAP_DIR=… DEMO=1 RENDER_SCALE=0.3 "release/mac-arm64/Wall Touch.app/Contents/MacOS/Wall Touch"`
  — phải thấy `[ndi] senders started` và ảnh snap **không đen** (đo: >20% pixel sáng).
  Đây chính là cái bẫy đã hạ Door Portals v1.0.3.

## 7b. 🪟 MÁY SHOW LÀ WINDOWS — đã kiểm được gì từ xa

Không có máy Windows để chạy thử, nhưng **ruột bản CI build đã soi được** (giải nén
`Wall.Touch-1.0.0-win.zip` rồi đọc bảng import PE của native module):

| kiểm | kết quả |
|:--|:--|
| `grandiose.node` kiến trúc | **x64** ✅ |
| `grandiose.node` phụ thuộc | chỉ `KERNEL32.dll` + **`Processing.NDI.Lib.x64.dll`** (liên kết cứng) |
| DLL NDI đi kèm app | có, `dist/` cạnh chính `grandiose.node` — **x64, NDI 6.3.2.0, 28.5 MB** |
| `app.asar` | đủ `src/`, `config.json`, `index.html`, `main.js` |

→ **KHÔNG cần cài NDI Runtime riêng.** DLL nằm ngay cạnh `.node`, mà Node nạp module native
bằng `LOAD_WITH_ALTERED_SEARCH_PATH` nên Windows tìm phụ thuộc **trong đúng thư mục của
`.node`**. (Ghi chú cũ trong README Door Portals nói "cần NDI Runtime" — với app này thì không.)
Nếu on-site vẫn lỗi nạp NDI thì mới cài NDI Tools như phương án dự phòng.

**Vẫn phải kiểm tại chỗ** (không suy từ xa được): fps thật ở 10350×1080 trên RTX 5080, và
đường xuất NDI nào nhanh hơn — chạy 2 lần rồi so **số hình NDI/giây** (số sau `DOOR-WALL-1=`
trong dòng `[perf]`, chia 5), **không phải fps**: mặc định (NDI trong renderer) và `set NDI_IPC=1`.

**Xem log trên Windows:** mở Command Prompt ngay trong thư mục cài (bấm thanh địa chỉ,
gõ `cmd` → Enter) rồi chạy `"Wall Touch.exe"`; hoặc bấm vào cửa sổ app → **Ctrl+Shift+I** → tab
Console. Đặt biến bằng `set TÊN=1` trước khi chạy, xoá bằng `set TÊN=`.

**Nếu app hỏng lúc khởi động thì KHÔNG còn màn hình đen nữa** — từ v1.0.1 mọi lỗi renderer
được in đè lên toàn màn hình bằng chữ đỏ đọc được từ xa (`#fatal` trong `index.html`).

## 7b-bis. 🎯 HIỆU CHỈNH VỊ TRÍ CHẠM (u,v lệch) — 2026-08-11

**Triệu chứng tại hiện trường:** tường 1 (180 cm) khớp hoàn toàn; 4 tường còn lại track
đúng nhưng **lệch một chút so với bàn tay**.

**Nguyên nhân:** toạ độ liên tục `u,v` của bridge đi qua **warp quad**, mà HANDOFF của
bridge đã ghi: *"mép trái/phải quad là ước lượng bằng mắt vì tia laser đi vượt qua góc
phòng nên baseline không hề thấy mép tường"*. Tường 1 hẹp nên đoán trúng; tường rộng
4.4–6.2 m thì không.

**Vì sao trước giờ không ai thấy:** Door Portals chỉ dùng `/zone/`, mà bridge test zone
bằng `pointInPoly` trên **toạ độ thế giới (mét)** — `pipeline.js:518`, **không** qua
homography. Sai số warp nằm im suốt cho tới khi app này dùng u,v.

**Cách sửa — ngay trong app, không đụng vào bridge** (giữ nguyên setup zone đang chạy tốt
của Door Portals):

1. Bấm **`k`** (hoặc chạy với `CALIB=1`) → mặt nước tối lại, mỗi tường hiện
   **vạch XANH LÁ ở 25%** và **vạch CAM ở 75%** bề rộng tường. Vạch **trắng** = chỗ app
   đang nghĩ tay bạn ở đó; **khoảng cách giữa vạch trắng và tay bạn CHÍNH LÀ sai số**.
2. Đứng đúng vạch **xanh lá**, đặt tay lên tường, bấm **`[`**.
3. Đứng đúng vạch **cam**, đặt tay lên tường, bấm **`]`**.
4. **Không cần bấm gì cả** — giữ tay yên trên vạch ~1.4 s là app tự bắt (vạch bắt được
   sẽ **chuyển sang trắng và dày lên**, cả phòng nháy một cái). Bắt đủ 2 vạch thì tự
   giải, tự áp dụng, tự lưu. Lặp cho từng tường.
   (Nếu có người ngồi máy thì vẫn dùng được `[` `]` `s` như cũ.)

Hai điểm ở 25%/75% ghim được **cả hai ẩn số cùng lúc** — quad bị dịch (offset) và quad
sai bề rộng (scale) — mà một điểm thì không bao giờ tách được.

**⚠️ File lưu KHÔNG nằm cạnh app.** Bản đóng gói có `config.json` **bên trong `app.asar`**
— file nén, ghi vào là `ENOENT` (đã dính đúng lỗi này tại hiện trường 2026-08-11). Hiệu
chỉnh được ghi ra **`userData`**:
- Windows: `%APPDATA%\Wall Touch\config.json`
- macOS: `~/Library/Application Support/Wall Touch/config.json`

File đó là **lớp phủ**: app đọc `config.json` gốc trước, rồi chồng file này lên. Muốn xoá
hiệu chỉnh thì xoá file đó. Đường dẫn được in ra log lúc khởi động và hiện trên HUD sau
khi lưu.

**Đọc kết quả để biết hỏng ở đâu:** `uScale ≠ 1` → bề rộng quad sai; `uOffset ≠ 0` → quad
bị dịch, hoặc sensor **không gắn đúng giữa tường** (HANDOFF bridge mục 15 ghi đây là ẩn số
duy nhất không suy được từ dữ liệu — chủ dự án xác nhận bằng miệng, chưa đo).

**Muốn sửa tận gốc** thì kéo lại `warp.corners` của 4 mặt đó trong LiDAR Bridge cho khớp
mép tường thật. Nhưng làm trong app nhanh hơn nhiều và không có rủi ro động vào preset
đang chạy tốt.

## 7c. Vệt trail trên tường thật khác gì so với kéo chuột

Cùng một đường code (`paintStroke`) — nhưng có **một chỗ chỉ tường thật mới lộ**:

Bàn tay trượt trên tường **không chắc giữ nguyên một danh tính**. Bridge có thể mất dấu
rồi bắt lại (id mới), và **đi qua GÓC PHÒNG thì sang hẳn sensor khác** → prefix khác, id
khác. Không xử lý thì một cú quẹt dài ra thành nhiều nét rời, mỗi nét một màu, mỗi nét
lại "tõm" một phát như chạm mới.

→ `stitchGhost()` trong `app.js`: track vừa biến mất được giữ lại `stitchSeconds` (0.7 s).
Nếu có track "mới" xuất hiện trong bán kính `stitchRadius` (0.30 mét-tường ≈ 72 cm) của
một ghost thì coi là **cùng một bàn tay** — kế thừa màu, nối nét từ vị trí cũ, và **không
tạo giọt rơi**. Bán kính đó đủ rộng để nuốt cả cú băng qua góc phòng.

**Phải kiểm tại chỗ:** quẹt một đường dài băng qua góc giữa hai tường, xem nét có liền và
giữ nguyên màu không. Nếu vẫn đứt thì nới `stitchRadius`/`stitchSeconds`.

## 8. Còn nợ

1. **Chưa chạy thử với LiDAR thật.** Cần: bật bridge (preset cũ, không sửa) → `npm start` →
   bấm `h`, xem `pkts` tăng và `touches/wall` đúng → chạm cửa **trái tường 2** xem vệt hiện
   bên trái hay phải (nếu ngược thì trục +x của sensor đó lật — xử ở bridge, không sửa app).
2. **Chưa đo ở full 10350×1080 trên máy show** (xem mục 7b). Contour là shader full-res, cần xem fps thật.
   Nếu thiếu: hạ `waves.substeps` hoặc `look.bloomIters` trước, đừng hạ độ phân giải render.
3. **`npm install` không tải nổi binary Electron** (giải nén hỏng, thiếu `Frameworks`). Đã vá bằng
   cách copy `node_modules/electron/dist` + `path.txt` từ `~/door-portals`. Máy mới mà lỗi lại
   thì làm y vậy.

## 9. Quy tắc tiết kiệm credit

Giống Door Portals: **không tự chụp screenshot**. Muốn xem thì
`mkdir -p $SNAP_DIR && SNAP_DIR=… SNAP_AT=7000,13000 DEMO=1 RENDER_SCALE=0.35 npm start`,
cắt dải canvas ra khỏi ảnh cửa sổ (canvas nằm giữa, cao đúng `W*1080/10350`), downscale,
**chỉ đưa 1 ảnh khi cần quyết định**. Gộp nhiều chỉnh vào 1 lần rồi mới render.
`zsh` không có `timeout` → chạy nền rồi `pkill -f "wall-touch/node_modules/electron"`.

## 10. Trang so sánh hướng visual

`preview/looks.html` — mở thẳng bằng trình duyệt, không cần Electron. 3 hướng
(sóng giao thoa / màng tế bào / sợi từ trường), rê chuột để giả làm tay, có nút xem
1 tường hay cả 5 tường. **Đã chốt hướng 1.** Giữ file lại để sau này cần thử hướng khác
thì sửa ở đây trước — rẻ hơn sửa cả app nhiều.
