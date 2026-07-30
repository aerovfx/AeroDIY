# DIY — STEM Hardware Studio (AeroVFX Studio)

Không gian thiết kế phần cứng DIY/STEM bằng hội thoại: mô tả sản phẩm → BOM → sơ đồ
điện → **CAD 3D** → **mô phỏng CFD** → hướng dẫn lắp. 34 project template (UAV, USV,
robot, máy in 3D, wearable…). README này tập trung vào hai phần kỹ thuật nặng nhất
của dự án: **CAD** và **CFD**.

## Khởi chạy

```bash
npm install
npm run dev     # dev server, cổng 3000
npm test        # mcp:build + build + node --test tests/*.test.mjs
```

---

## CAD

### Domain engine (`lib/cad-engine.ts`)

Sinh **feature tree** xác định (deterministic) từ một mô tả sản phẩm: parametric
primitives (box/cylinder/…), ràng buộc kích thước khung, khoảng hở, điểm gá, motor
và propeller. `POST /api/cad` ([app/api/cad/route.ts](app/api/cad/route.ts), input
qua Zod) trả về feature tree, `validation` (điểm số + số check đạt/tổng), `metrics`
(kích thước, khối lượng vật liệu ước tính, thời gian in) và scene specification cho
viewport. Kết quả không đổi giữa các lần gọi với cùng input — test ăn theo tính chất
này (`tests/cad-engine.test.mjs`).

### Viewport 3D (`app/components/CadViewport.tsx`)

Three.js/WebGL2: orbit, pan, zoom, preset view (ISO/TOP/FRONT) và **exploded view**.
`extractAssemblyTrianglesMm` lấy mesh thật của scene (world-transform, cùng bộ lọc
bỏ qua các phần không va chạm như đĩa motion-blur cánh quạt) — mesh này được CFD 3D
tái sử dụng trực tiếp (xem phần CFD bên dưới), không dựng lại hình học riêng.

### Xuất CAD native — FreeCAD & Plasticity

Hai bridge độc lập chuyển feature tree đã kiểm định (validated) thành B-Rep thật,
đều chỉ bind `127.0.0.1` và không nhận payload tùy ý:

- **DIY CAD runtime** ([lib/freecad-runtime.ts](lib/freecad-runtime.ts),
  [cad-runtime/](cad-runtime/README.md)): chạy FreeCADCmd/OpenCascade headless,
  xuất `FCStd` + `STEP` + `STL` cùng manifest. Worker chỉ nhận allowlist primitive
  có kiểu dữ liệu, không `eval`/`exec` script do model sinh.
  ```bash
  FREECAD_CMD=/Applications/FreeCAD.app/Contents/Resources/bin/FreeCADCmd npm run cad:runtime
  curl http://127.0.0.1:44045/health
  ```
- **Plasticity adapter** ([lib/plasticity-runtime.ts](lib/plasticity-runtime.ts)):
  chuyển hệ trục Y-up Three.js sang hệ trục CAD, đổi mm sang scene units, dựng
  box/cylinder B-Rep có tên và group theo project/draft, mở trong Plasticity với
  undo/redo. Mặc định kết nối `http://127.0.0.1:44044`, kiểm tra origin trước khi
  điều khiển kernel.

### MCP CAD server

`mcp-server/` ([hướng dẫn kết nối](mcp-server/README.md)) công bố 5 tool qua stdio:
sinh feature tree từ prompt STEM, kiểm định kích thước/khoảng hở/khả năng chế tạo,
sinh Three.js scene spec, `cad.build_native_artifacts` (FreeCAD/OpenCascade →
FCStd/STEP/STL) và `cad.open_in_plasticity`, cùng resource
`cad://projects/budget-mini-uav`.

```bash
npm run mcp:build
npm run mcp:smoke
npm run mcp:start
```

Xem thêm [kiến trúc CAD MVP](docs/ARCHITECTURE.md).

---

## CFD

Ba lớp tách biệt, **không được trộn lẫn** (xem quy tắc đầy đủ trong `CLAUDE.md`):

| Lớp | File | Vai trò |
|---|---|---|
| Ước lượng giải tích | [lib/cfd-engine.ts](lib/cfd-engine.ts) | Gate sàng lọc nhanh từ hình học (**CFD-LITE**) — tương quan kinh nghiệm, không phải nghiệm số. |
| Solver số 2D | [lib/cfd-lbm.ts](lib/cfd-lbm.ts) | Lattice Boltzmann D2Q9, giải Navier–Stokes 2D. Headless, không DOM. |
| Solver số 3D (JS reference) | [lib/cfd-lbm3d.ts](lib/cfd-lbm3d.ts) | D3Q19 thuần JS (~11 MLUPS) — nguồn sự thật đối chiếu cho kernel GPU. |
| Solver số 3D (GPU) | [lib/cfd-lbm3d-gpu.ts](lib/cfd-lbm3d-gpu.ts) | Kernel WGSL **sinh từ đúng bộ hằng số** của reference JS, chạy WebGPU thật. |
| Trực quan 2D | [app/components/CfdLbmCanvas.tsx](app/components/CfdLbmCanvas.tsx) | Canvas 2D, hầm gió trực tiếp, hạt mực. |
| Trực quan 3D | [app/components/CfdGpuViewport.tsx](app/components/CfdGpuViewport.tsx) | Hầm gió 3D quanh đúng mesh CAD người dùng đang thiết kế. |
| Dev lab | [app/gpu-lab/page.tsx](app/gpu-lab/page.tsx), [public/webgpu-spike.html](public/webgpu-spike.html) | So kernel WGSL vs JS, benchmark MLUPS, validate Cd quả cầu. |

### Nguyên tắc bắt buộc (đã có test giữ, không được nới lỏng)

1. **Không trình bày số ước lượng như số đo** — CFD-LITE là tương quan, CFD-LBM là
   đo được; nhãn UI và tên trường phải phân biệt rõ.
2. **Luôn công bố giới hạn** — Re thực của UAV (~4·10⁴) vượt dải ổn định BGK trên
   lưới vài chục nghìn ô nên omega bị kẹp; UI hiện cả `reynolds.physical` và
   `reynolds.simulated`.
3. **Tỷ lệ chắn kênh (blockage) đi kèm Cd** — trên ~10% tường bó dòng làm Cd đo
   được cao hơn giá trị không gian tự do.
4. **Quy ước dấu tách theo chiều 2D/3D** — 2D: trục y lưới hướng xuống, lực nâng
   là `-fy`. 3D: trục y hướng lên (map thẳng CAD), lực nâng là `+fy`. Đừng trộn.
5. **Đo lực tại ô solid**, không tại ô fluid — độc lập với thời điểm gọi trong
   bước collide/stream.
6. **Không đọc Cd/Cl trước khi dòng phát triển** — canvas khoá readout tới
   `SETTLE_STEPS`; solver headless dùng `warmupSteps`.

### Mốc đã kiểm chứng (giữ trong `tests/cfd-lbm.test.mjs`, `tests/cfd-lbm3d.test.mjs`)

- Trụ tròn Re=100, chắn kênh <10%: **Cd ≈ 1.4** (sách), **St ≈ 0.164**, Cl ≈ 0 khi
  đối xứng; thân thuôn có Cd nhỏ hơn trụ tròn cùng bề dày.
- MRT tái hiện đúng vật lý BGK ở Re=100, và giữ ổn định ở Reynolds mà BGK phân kỳ
  (BGK NaN ở Re 3000; MRT chạy tới Re 12000, đắt hơn ~+21.8%).
- Smagorinsky LES: nhớt xoáy → 0 khi dòng mượt, tăng khi dòng bị xé — cho lưới thô
  chạy Re cao không nổ.
- 3D: quả cầu Re=100 đo 1.435 (sách 1.092, lạm phát mảng tuần hoàn ×1.31); Cd(100)
  > Cd(300) đơn điệu.
- **GPU (`/gpu-lab`, apple·metal-3)**: đối chiếu 30 bước với reference JS —
  max|Δf| BGK 2.7e-7, LES 5.4e-7 (mức làm tròn FP32); 328–399 MLUPS kèm LES tuỳ cỡ
  lưới; quả cầu @9.4D Re=100 Cd 1.203±0.002 (×1.10 so sách, tốt hơn ×1.31 ở 4.8D).

### Xem thử

```bash
npm run dev
```

- Tab **CFD** trong workspace chính: hầm gió 2D trực tiếp trên mặt cắt UAV đang
  thiết kế; nút **MỞ HẦM GIÓ 3D** dựng hầm gió GPU quanh đúng mesh CAD.
- `/gpu-lab`: benchmark hiệu năng GPU và đối chiếu số với solver JS reference.

Giới hạn nói thẳng trên UI: biên ngang tuần hoàn (mảng ảnh vài lần đường kính vật),
lưới hiện tại chưa đạt độ phân giải mức sách giáo khoa — số liệu dùng để **so sánh
tương đối giữa các phương án thiết kế**, không phải số chứng nhận khí động học.

---

## Tài liệu khác

- [Kiến trúc MVP](docs/ARCHITECTURE.md)
- [Hợp đồng MCP CAD v1](mcp/cad-tools.schema.json)
- [Hướng dẫn MCP server](mcp-server/README.md)
- [DIY CAD runtime](cad-runtime/README.md)
