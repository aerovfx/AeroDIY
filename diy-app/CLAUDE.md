# DIY STEM Hardware Studio — Context

Xưởng thiết kế phần cứng DIY/STEM (brand **AeroVFX Studio**): từ mô tả sản phẩm →
BOM kèm nguồn mua → sơ đồ điện → CAD 3D → mô phỏng → hướng dẫn lắp. 34 project
template (UAV, USV, robot, máy in 3D, wearable…).

## Tech stack

- Next.js 16 + React 19, chạy trên Cloudflare Workers qua `vinext` + Vite 8
- TypeScript strict; Three.js cho viewport CAD; Drizzle + D1
- MCP server (`mcp-server/`) build riêng qua `tsconfig.mcp.json` → `dist-mcp/`
- Test: `node --test tests/*.test.mjs`, import từ `dist-mcp/` (không phải `lib/`)

## Lệnh

```bash
npm test          # mcp:build + build + node --test tests/*.test.mjs
npm run mcp:build # biên dịch lib/ + mcp-server/ -> dist-mcp/
npm run dev       # dev server, cổng 3000
```

## Coding style

- 2 space, double quote, có semicolon; `function` cho top-level, arrow cho callback
- Tên biến đầy đủ, không viết tắt (`primitive` không phải `p`, `velocityMs` không phải `v`)
- Comment giải thích **tại sao**, viết tiếng Việt, đặt trên đoạn khó — không comment lại điều code đã nói rõ
- Không thêm dependency mới nếu chưa hỏi
- File `lib/*.ts` phải chạy được cả trong browser và node (không dùng DOM API) —
  vì test và MCP import trực tiếp từ `dist-mcp/`. Code cần DOM đặt ở `app/components/`.

## Module CFD — quy tắc riêng

Ba lớp, không được trộn lẫn:

| Lớp | File | Vai trò |
|---|---|---|
| Ước lượng giải tích | `lib/cfd-engine.ts` | Gate sàng lọc nhanh từ hình học (CFD-LITE). Tương quan kinh nghiệm, không phải nghiệm số. |
| Solver số | `lib/cfd-lbm.ts` | Lattice Boltzmann D2Q9, giải Navier–Stokes 2D. Headless, không DOM. |
| Trực quan | `app/components/CfdLbmCanvas.tsx` | Canvas 2D, hầm gió trực tiếp. |

**Nguyên tắc bắt buộc:**

1. **Không bao giờ trình bày số ước lượng như số đo.** `CFD-LITE` là tương quan;
   `CFD-LBM` là đo được. Nhãn UI và tên trường phải phân biệt rõ.
2. **Luôn công bố giới hạn.** Re thực của UAV (~4·10⁴) vượt dải ổn định BGK trên
   lưới vài chục nghìn ô, nên omega bị kẹp → phải báo cả `reynolds.physical` và
   `reynolds.simulated`, không được chỉ hiện một số.
3. **Tỷ lệ chắn kênh (blockage) phải báo cùng Cd.** Trên ~10% thì tường bó dòng
   và Cd đo được cao hơn giá trị không gian tự do — thiếu con số này thì việc so
   với benchmark là vô nghĩa.
4. **Quy ước dấu:** trục y của lưới hướng XUỐNG. Lực nâng (hướng lên trong hệ CAD)
   là `-fy` khi mô phỏng mặt cạnh. Sai dấu ở đây từng làm Cl đảo chiều.
5. **Đo lực tại ô solid**, không tại ô fluid — cách này độc lập với thời điểm gọi
   trong bước (vì `collide()` không tác động lên ô solid).
6. **Không công bố Cd/Cl trước khi dòng phát triển.** Canvas khoá readout tới
   `SETTLE_STEPS`; solver headless dùng `warmupSteps` rồi mới lấy mẫu.
7. Colormap khoa học (speed/vorticity/pressure) **không** đổi theo brand — chúng
   mang ý nghĩa định lượng, xanh↔đỏ cho xoáy là quy ước.

**Mốc kiểm chứng** (giữ trong `tests/cfd-lbm.test.mjs`, đừng nới lỏng):
trụ tròn Re=100 chắn kênh <10% → Cd ≈ 1.4 (sách); St ≈ 0.164; Cl ≈ 0 khi đối xứng;
thân thuôn phải có Cd < trụ tròn cùng bề dày.

### Thuật toán trong solver và lý do tồn tại

| Thuật toán | Vì sao có | Số đo biện minh |
|---|---|---|
| BGK collision | Mặc định, rẻ nhất | 1.07 ms/bước ở lưới 300×140 |
| MRT collision | BGK nổ khi omega → 2 | BGK NaN ở Re 3000; MRT trụ tới Re 12000, đắt hơn **+21.8%** |
| Smagorinsky LES | Lưới thô chạy Re cao không nổ | ν_t → 0 khi dòng mượt (×1.00), ×2.98 khi |Π|=1e-2; trường lệch 17.5% ở Re 3000; +48.3% so BGK |
| Vô hướng D2Q5 | Trường khói đặc (đối lưu–khuếch tán) | khói tới hạ lưu, nồng độ chặn <2, không lọt vào solid |
| Kích xoáy | Bất ổn Karman mọc quá chậm từ nhiễu đối xứng | ClRms @500 bước: 0.021 → 0.251 (×12) |
| Đóng hình thái học | Bóng CAD rasterize ra nhiều mảnh rời | 4 khối rời → 1 khối liền ở radius 3 |

**Bẫy đã gặp, đừng lặp lại:**

1. **Đừng dùng "magic parameter" Λ=3/16 cho s_q của MRT nếu mục tiêu là ổn định.**
   Ở omega=1.96 nó cho s_q≈0.017, moment bậc cao gần như không hồi phục và solver
   nổ ngay — tệ hơn cả BGK. Dùng `MRT_RATES_STABLE` (s_q=1.9).
2. **Moment `m7` là Πxx − Πyy, không phải Πxx.** Tính LES sai tensor sẽ ra hệ số
   nhớt xoáy lệch.
3. **Lattice vô hướng dùng bảng streaming tuần hoàn** — thiếu điều kiện biên thì
   khói cuộn từ outlet về inlet (nhìn thấy được: vệt lược ở mép trái).
4. **`solveLbm` kẹp omega của BGK ở `OMEGA_MAX`.** Test nào cần chứng minh BGK
   mất ổn định thì phải gọi `stepLbm` trực tiếp, không qua `solveLbm`.
5. **Đừng gọi `speedColor`/`vorticityColor` trong vòng vẽ canvas** — mỗi pixel một
   mảng mới, 42.000 lần cấp phát/frame. Inline vào chỗ vẽ: 2.05 ms → 0.26 ms.
6. **Benchmark phải warm-up JIT cho MỌI nhánh trước khi đo, và xen kẽ các biến thể.**
   Đo tuần tự từng nhánh cho ra "MRT chỉ đắt hơn BGK 2%" — sai, vì BGK bị đo trong
   lúc JIT còn đang biên dịch. Đo lại đúng cách: +21.8%. Lấy trung vị nhiều vòng.
7. **Đo Strouhal bằng đếm đổi dấu trần là không dùng được khi shedding yếu.** Ở
   clRms≈0.03 nhiễu tự tạo ra vô số lần đổi dấu, St nhảy 0.296/0.148/0.111/0.259
   trên cùng bài toán. Dùng trigger Schmitt (ngưỡng ±0.5·RMS) → St=0.158 ổn định.
8. **Shedding đo ở lực NGANG (Cl), không ở lực cản.** `cdRms` còn chứa transient
   khuếch tán chậm nên không dùng để kết luận "wake ổn định".
9. **Hạt mực phải trôi theo thời gian SIM, không theo số frame.** Canvas chạy 3-6
   bước sim mỗi frame; advect mực 1 lần/frame làm dải mực đi chậm hơn dòng 3-6 lần,
   mất ~10 s mới băng hết miền — người dùng chỉ thấy vài vệt ngắn ở inlet và kết
   luận "không có dòng chảy". Nhân advection và tuổi theo `stepsPerFrame`.
10. **Toàn bộ việc vẽ nằm trong RAF, nên pane ẩn ⇒ canvas TRỐNG hoàn toàn.** Hâm
   nóng đồng bộ (`PREWARM_STEPS`) khi dựng vật cản để khung vẽ đầu tiên đã có dòng
   phát triển, thay vì để người dùng ngồi xem nó bò lên từ 0.
11. **Đừng `stroke()` cho từng hạt mực.** ~400 lệnh stroke có `shadowBlur` + ~3200
   lệnh stroke thường mỗi frame là đủ làm sụp FPS. Gộp segment theo bucket
   (hue × dải tuổi) → ~60 lệnh stroke, và tự tắt glow khi FPS < 45.
12. **`npm run lint` phải xanh.** Gán/đọc `ref.current` trong thân component hoặc
   trong JSX là lỗi `react-hooks/refs` — đồng bộ ref trong `useEffect`, và dùng
   state cho giá trị cần hiển thị.

### Solver 3D (`lib/cfd-lbm3d.ts`) — bước 1 của lộ trình WebGPU

Bản reference D3Q19 thuần JS (~11 MLUPS): NGUỒN SỰ THẬT về thuật toán. Kernel
WGSL (bước 2) phải đối chiếu từng giá trị với nó trên lưới nhỏ trước khi tin số
đo hiệu năng — spike đã chứng minh cách làm (max|Δf| = 3.3e-7 sau 20 bước).
Spike + số GPU đo được: `public/webgpu-spike.html` (apple metal-3: 256–372 MLUPS,
lưới 256×128×128 = 16.35 ms/bước).

**Quy ước 3D — KHÁC 2D, đừng trộn:**

1. **Trục y hướng LÊN** (map thẳng CAD), lực nâng = **+fy**. Bản 2D lật y theo
   màn hình canvas nên lực nâng là −fy — quy ước đó chỉ thuộc về canvas 2D.
2. **Biên ngang (y, z) TUẦN HOÀN** = mảng vật thể cách đều, không phải vật thể tự
   do. Cd đo được cao hơn sách ×1.2–1.5 ở khoảng cách ảnh ~5D (hiệu chuẩn được,
   xem `latticeSpacingDiameters`). **Ở khoảng cách ~5D, độ nhạy hình dáng bị che
   gần hết** (đĩa phẳng vs quả cầu cùng Cd trong sai số!) — muốn so sánh hình
   dáng phải giãn khoảng cách ảnh ≥ 8–10D, tức cần lưới GPU.
3. **Diện tích tham chiếu = diện tích cản THẬT** (đếm cột chiếu theo dòng);
   D = đường kính tương đương sqrt(4A/π). Cd 3D so thẳng được với đường cong
   quả cầu (Schiller–Naumann có sẵn: `sphereDragSchillerNaumann`).
4. **"Collision" với hình học = mesh tam giác thật của Three.js**, không phải hộp
   bao primitive: `voxelizeMeshMm` nhận `geometry.toNonIndexed()
   .getAttribute("position").array` (three core chạy trong node, KHÔNG import
   three vào lib). Ray-parity theo cột; mesh hở bị đếm vào `openColumns` thay vì
   tô sai trong im lặng. Độ chính xác đo được: thể tích −1.0%, diện tích cản 0.0%
   với SphereGeometry. `voxelizeScene` (primitive giải tích) là đường nhanh/fallback.
5. **Test miền trống mù với lỗi đảo chiều outlet** (hai cột cuối giống nhau ⇒
   copy xuôi/ngược đều no-op) — phải test bằng wake thật: residual zero-gradient
   và hụt wake tại outlet (mutation-check đã chứng minh cặp số 7.4e-5/3.5e-3 gốc
   vs 5.2e-4/5.6e-4 khi đảo).
6. Mốc quả cầu: Re=100 đo 1.435 (sách 1.092, lạm phát mảng ×1.31); đơn điệu
   Cd(100) > Cd(300). Ở Re≈150, thân thuôn 3D KHÔNG rẻ hơn quả cầu (ma sát diện
   tích ướt thắng lợi ích wake) — đừng viết test "thuôn < tròn" như 2D.

### GPU 3D (`lib/cfd-lbm3d-gpu.ts` + `app/gpu-lab/page.tsx`) — bước 2, ĐÃ KIỂM CHỨNG

Kernel WGSL **sinh từ đúng bộ hằng số của reference** (không chép tay); harness
nhận WebGPU qua interface cấu trúc `GpuDeviceLike` nên lib vẫn headless và node
test được phần sinh WGSL. Lực đo ngay trên GPU (momentum-exchange, atomic
fixed-point 2^22) — không đọc buffer f về CPU.

**Số đã đo trên apple·metal-3 (trang `/gpu-lab`, promise thuần — chạy được khi
tab ẩn):**
- Đối chiếu 30 bước với reference: max|Δf| BGK **2.7e-7**, LES **5.4e-7**, lệch
  lực **4.1e-6** — mức làm tròn FP32, kernel tương đương thuật toán.
- Hiệu năng kèm LES: 399 / 390 / **328 MLUPS** (0.39M / 1.18M / 3.15M ô);
  lưới 192×128×128 = 9.59 ms/bước.
- Quả cầu @9.4D: Re=100 Cd **1.203±0.002** (sách 1.092, ×1.10 — giảm từ ×1.31
  ở 4.8D); Re=300 LES Cd 0.822 (×1.20).
- Đĩa vs cầu — CHUỖI HỘI TỤ độ nhạy hình dáng (Re=150, cùng tỷ lệ hình học):
  **×1.00** (5D, D=10, JS) → **×1.08** (9.4D, D=14) → **×1.12** (8.1D, D=20,
  lưới 256×160×160 = 6.55M ô, ~1 GB buffer). Đơn điệu về phía tự do (~×1.5)
  nhưng còn xa: cả khoảng ảnh LẪN phân giải mép đều bù được một phần. Mức sách
  cần D≈40 + spacing ≥10D ⇒ ~80M ô (~6 GB) — vượt giới hạn buffer 1 GB hiện
  tại; muốn tới đó phải FP16 storage hoặc chia buffer. SO SÁNH TƯƠNG ĐỐI giữa
  các hình dáng ở D 15–20 vẫn có nghĩa (chênh lệch ×1.12 với RMS ~0.005 là tín
  hiệu thật), nhưng đừng trình bày nó như phân biệt tuyệt đối mức sách.

Bẫy đã gặp ở bước 2: kernel fused phải TƯƠNG ĐƯƠNG chuỗi stream→inlet→outlet→
bounce-back→collide của reference — outlet cell gather "như thể đứng ở nx−2" rồi
collide chung; solid cell pull `f_old[i+c_q][OPP[q]]`; inlet ép feq rồi VẪN cho
qua collide (BGK bất động tại cân bằng). Lệch thứ tự là max|Δf| nhảy lên ngay.

### Hầm gió 3D trong tab CFD (`app/components/CfdGpuViewport.tsx`) — bước 3

Chuỗi dữ liệu: `extractAssemblyTrianglesMm` (CadViewport — mesh three.js THẬT,
world-transform, cùng bộ lọc skip với voxelizer) → `voxelizeMeshMm` → solver GPU
→ tracer advect trên GPU + mặt cắt xoáy đọc theo dải liên tục. Mount qua nút
"MỞ HẦM GIÓ 3D" — không tự chiếm GPU của mọi người dùng.

Số đo trên quad mặc định (lưới 160×96×96, Re 500, AOA 4°): 2.002 voxel, D=20 ô,
**287–299 MLUPS** kèm tracer + slice + lực; Cd ≈ 1.9 (mảng ảnh ngang chật ~1.6
sải — nhãn UI nói rõ "không phải số chứng nhận"). 5/9.216 cột mesh hở (0.05%,
từ lathe/tube không kín) — `openColumns` hiển thị công khai trên header.

**Bẫy bước 3:**
1. **three.js (WebGL) không chia sẻ buffer với WebGPU** — tracer advect trên GPU
   rồi đọc về 32 B/hạt để nạp BufferAttribute; đừng cố kéo cả trường vận tốc
   (18 MB/frame) về CPU.
2. **Môi trường nhúng có thể misreport `document.hidden` = true vĩnh viễn** —
   gate render cứng theo visibility làm canvas đen dù sim chạy. Vẫn render định
   kỳ (mỗi ~20 tick) khi hidden.
3. Transform mesh→lattice dùng `latticeFromMm` từ kết quả voxelize (đã có test
   node) — đừng tự cộng trừ origin bằng tay ở viewport.
4. **Cánh quạt quay** (tham khảo hangar Pidron, skill `threejs-drone-models`):
   phần quay nằm trong group con `userData.propSpinner`, đĩa motion-blur gắn
   `userData.noCollision` để extractor bỏ qua (không loại thì voxelizer biến nó
   thành đĩa ĐẶC chắn dòng). Pha khởi đầu của cánh phải TIỀN ĐỊNH theo hash id —
   `Math.random()` làm bóng voxel đổi theo từng lần mở (đo được 2002↔2063 ô).
   Khi gắn nhãn primitive đừng ghi đè cả `object.userData` — sẽ xoá mất spinner.

**Mặt cắt UAV trong hầm gió:** catalog `UAV_SECTIONS` nằm ở `CfdLbmCanvas.tsx`
(app layer) chứ KHÔNG đưa builder dữ liệu vào `lib/cfd-lbm.ts` — solver phải giữ
generic, không phụ thuộc project data. Mỗi mặt cắt là bóng chiếu mặt cạnh của đúng
scene CAD template (cùng đường rasterize với dự án đang mở, cache theo id). Đảo
2–6 ô tách khỏi khối chính là đầu cánh quạt trong hình chiếu cạnh — đúng vật lý,
đừng tăng closeRadius để "hàn" chúng.

**Cách kiểm chứng thị giác:** `requestAnimationFrame` bị treo khi Browser pane ẩn,
nên không tinh chỉnh được hình ảnh qua screenshot. Dùng harness render headless
(dump trường + hạt mực từ `dist-mcp` rồi render bằng PIL) mô phỏng đúng thứ tự vẽ
của canvas — xem `reports/FINAL-project.png`.

## Design system

Bảng màu lấy từ logo AeroVFX (`public/logo.png`): kính tím `#9b4de0`, vỏ mũ indigo
`#2e2a6e`, hành tinh oải hương `#dda9ec`, đĩa xanh rừng `#1d3b2c`. Token ở đầu
`app/globals.css`. Xanh lá giữ nghĩa "đạt", đỏ/hổ phách giữ nghĩa lỗi/cảnh báo.

CSS viết minified một dòng theo từng nhóm component (theo đúng file hiện có).
Font: Geist. Chữ tiếng Việt: **Arial Black không có glyph dấu** — dùng Arial Bold
khi sinh ảnh raster.

## Kiểm thử & review

- Test phải **load-bearing**: sau khi viết, thử xoá đúng phần code nó canh và xác
  nhận test đỏ lên. Test pass rỗng còn tệ hơn không có test.
- Không nới lỏng ngưỡng để test xanh — nếu số lệch, tìm nguyên nhân vật lý trước
  (ví dụ Cd cao 26% hoá ra do blockage 21%, không phải lỗi solver).
- Thay đổi quan sát được trên UI thì phải mở browser xem thật, không chỉ dựa vào
  typecheck.
