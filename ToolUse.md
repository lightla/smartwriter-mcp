# Smartwriter MCP Tool Use

Tài liệu này mô tả toàn bộ tool hiện có của `smartwriter-mcp`, đủ để người đọc nắm nhanh “tab nào đang được điều khiển”, cách dùng marker/annotation, và cách map DOM -> source code.

Mục tiêu: đủ thông tin để agent dùng được ngay, nhưng output/khái niệm giữ gọn nhất có thể.

## 0) Mental Model (đọc 30s là dùng được)

- **Server**: `smartwriter-mcp` chạy local, nói chuyện với **Chrome extension**.
- **Flow tabs**: danh sách tab được đánh nhãn `t:1`, `t:2`, ... (chỉ để chọn tab).
- **Connected tab**: tại 1 thời điểm, chỉ có **1 tab** đang “được điều khiển” (click/type/get_dom_element... đều nhắm vào đây).
- **Annotations**: các mốc/marker `a:1`, `a:2`, ... trỏ tới một DOM target đã lưu (kèm selector primary/cssPath/xpath, note, url).

Quick start:

1. `tab_get_all_compact_info()` để thấy `t:n`
2. `tab_connect({ tabId: "t:2" })` để set connected tab
3. `get_compact_annotations()` lấy marker `a:n`
4. `get_dom_element({ selector: "a:n" })` hoặc `click({ selector: "a:n" })`

## 1) Nguyên tắc chung

### 1.1 Kết nối tab trước khi thao tác

Hầu hết tool thao tác DOM yêu cầu đã `tab_connect` vào một tab.

Luồng tối thiểu:

1. `tab_get_all_compact_info` (hoặc `flow_get_tab_ids`) để thấy `t:n`
2. `tab_connect({ tabId: "t:1" })`
3. Gọi `click/type/fill/...` hoặc `get_*`

### 1.2 Target/Selector bạn có thể truyền

Các tool nhận `selector` thường hỗ trợ:

- CSS selector: `div.foo > span`
- Annotation marker: `a:2` (từ `get_compact_annotations` / `flow_get_compact_annotations`)
- XPath: bắt đầu bằng `//` hoặc `/`
- Coords: dạng `x,y` (ví dụ `120,300`)
- Legacy ref: dạng `el:<id>` (ít dùng)

Ghi chú: marker `a:n` được resolve sang selector đã lưu (primary/cssPath/xpath) trong annotation.

### 1.3 Output: PSV gọn (không JSON)

Server trả text theo PSV (pipe-separated values), **không JSON**:

```text
path|data
value[0]|k=v;k2=v2;arr[]=a,b,"h,e"
```

Quy ước:

- Mỗi record (thường là `value[i]`) nằm trên **1 dòng**.
- `data` là chuỗi `k=v` nối bằng `;`.
- Array được biểu diễn `key[]=` và các phần tử nối bằng `,`:
  - tự dùng `""` nếu phần tử chứa `,` hoặc `"` hoặc newline.
- Map `{name,value}` (ví dụ `allAttrs`) được gộp `key[]=name=value,...` (mỗi `name=value` là 1 cell, có quote khi cần).
- Các block hay lặp được gộp để giảm text:
  - `element.attributes[]` gộp 1 dòng
  - `rect` gộp: `rect=x=...,y=...,w=...,h=...`
  - `selectors` ưu tiên `primary`, fallback `cssPath`, rồi `xpath` (giữ tối thiểu)
  - `fingerprints` gộp scalar vào 1 key, giữ `fingerprints.classList[]` và `fingerprints.allAttrs[]`

## 2) Tool groups (theo prefix)

Ghi chú nhanh về “có cần connected tab không”:

- Không cần connected tab: `cli_*`, `tab_get_all_compact_info`, `flow_*`
- Cần connected tab: `tab_focus_connected`, hầu hết `get_*` (trừ `flow_*`), toàn bộ action tools (`click/type/...`)

### 2.1 `cli_*` (server process & runtime info)

#### `cli_server_info()`
Xem thông tin server `smartwriter-mcp`:

- `pid`, `port`, `extensionConnected`, `wsUrl`

#### `cli_list_tools()`
Liệt kê tool name + mô tả (dùng để self-discovery).

#### `cli_kill_other_instances()`
Kill các instance `smartwriter-mcp` khác đang chạy (giữ lại instance hiện tại).

---

### 2.2 `tab_*` (quản lý tab đang connect)

#### `tab_get_all_compact_info()`
Trả danh sách tab theo flow marker:

- `t:1|<title>`
- `t:2|<title>`

#### `tab_connect({ tabId })`
Connect vào tab để thao tác.

- `tabId`: `"t:1"` hoặc số tabId (string/number)
- Output thường có `connectedTabId` và `flowMarker`

#### `tab_disconnect({ tabId? })`
Disconnect tab đang connect.

- Nếu không truyền `tabId`, disconnect tab hiện tại.

#### `tab_focus_connected()`
Bring tab đang connect lên foreground (Chrome).

---

### 2.3 `flow_*` (flow tabs & annotations across tabs)

#### `flow_get_tab_ids()`
Trả danh sách flow ids `t:1..t:n`.

#### `flow_get_compact_annotations({ type? })`
Trả annotations “gọn” trên **tất cả flow tabs**.

- `type`: `step | change | bug` (optional)
- Trả kèm `pageId|url` mapping

#### `flow_get_detail_anotations({ type? })`
Trả annotations chi tiết trên **tất cả flow tabs**.

#### `flow_clear_all_anotations()`
Xoá toàn bộ annotations trên **tất cả flow tabs**.

---

### 2.4 `get_*` (đọc DOM, component origin, annotations)

#### `get_snapshot({ selector? })`
Lấy accessibility snapshot (ARIA tree) của page hoặc của subtree nếu truyền `selector`.

Use case:
- agent cần hiểu cấu trúc UI nhanh mà không parse HTML thủ công.

#### `get_text({ selector })`
Lấy text content của target.

#### `get_attribute({ selector, attribute })`
Lấy giá trị 1 attribute cụ thể.

#### `get_dom_element({ selector })`
Lấy thông tin DOM “đủ dùng” và ổn định:

- tag, className/classList, attributes, textContent, innerHTML (truncated), rect
- thường trả kèm `elementRef` nội bộ (dùng cho debug/độ ổn định)

Use case:
- lấy fingerprint để chọn selector ổn định
- kiểm tra element có class/attrs gì để mapping về code

#### `get_component_source({ selector, project_path? })`
Mục tiêu: map DOM node ra “component source file” (React/Vue) nếu có thể.

Cơ chế:

1. **Runtime crawl** (trong page):
   - React: duyệt fiber, đọc `_debugSource` (dev build + sourcemap/debug info)
   - Vue: duyệt instance/vnode, đọc `type.__file` (thường có khi dev build)
2. Nếu runtime không có `sourceFile` (`NOT_FOUND...`):
   - Server dùng **fingerprint scan** để dò file trong codebase:
     - `project_path` (nếu cung cấp) là nơi scan
     - nếu không có `project_path` thì scan theo `cwd` của server (dễ match nhầm repo khác)

Khuyến nghị:
- Luôn truyền `project_path` trỏ vào repo thực tế của app để tránh false positive.
- Production build thường không có `__file`/`_debugSource`, khi đó scan là đường fallback.

Output thường gồm:
- `sourceFile`, `componentName`, `framework`, `analysisHint`
- `fingerprints.*` để agent quyết định độ tin cậy

#### `get_detailed_annotations({ type? })`
Trả annotations chi tiết của **tab đang connect**.

#### `get_compact_annotations({ type? })`
Trả annotations gọn của **tab đang connect** + mapping url.

---

### 2.5 Action tools (thao tác UI)

Các tool này thao tác trực tiếp lên DOM của tab đang connect.
Phần lớn nhận `selector` (CSS/XPath/coords/marker `a:n`) và tự resolve + retry nếu element ref stale.

#### `click({ selector })`
Click vào target.

#### `hover({ selector })`
Hover vào target.

#### `type({ selector, text })`
Gõ từng ký tự (char-by-char). Hữu ích cho input có event handler nhạy.

#### `fill({ selector, value })`
Set giá trị “nhanh” cho input/textarea (không char-by-char), vẫn dispatch events.

#### `select_option({ selector, options })`
Chọn option trong `<select>`.

#### `check({ selector })` / `uncheck({ selector })`
Tick/untick checkbox/radio.

#### `press_key({ key })`
Gửi key cho focused element (`Enter`, `Escape`, `Tab`, ...).

#### `wait_for({ text, timeout? })`
Chờ text xuất hiện trên page (default timeout ~5000ms).

#### `navigate({ url })`
Đi tới URL trong tab đang connect.

#### `go_back()` / `go_forward()` / `reload()`
Điều hướng history / reload trang.

#### `screenshot()`
Chụp screenshot của tab hiện tại.

#### `evaluate({ script, args?, marker?, index? })`
Chạy JS trong context của page.

Gợi ý dùng:
- Khi cần tính toán/kiểm tra state mà tool khác không cung cấp.
- Nếu muốn scope vào element theo annotation marker, ưu tiên dùng `marker: "a:2"` hoặc `index: 2` (tuỳ implementation build/extension).

Lưu ý:
- Tránh trả object quá lớn; tốt nhất trả scalar/string gọn.
- Nếu gặp lỗi kiểu `... 'a:2' is not a valid selector`, nghĩa là marker đang bị treat như CSS selector. Workaround: dùng `get_detailed_annotations()` lấy `selectors.primary` rồi truyền CSS selector đó vào `evaluate`.

---

### 2.6 `clear_*` (xóa annotations)

#### `clear_all_anotations()`
Xoá annotations của **tab đang connect**.

#### `flow_clear_all_anotations()`
Xoá annotations trên **tất cả flow tabs**.

## 3) Playbook nhanh

### 2.1 Xác định file component từ annotation

1. `tab_connect({ tabId: "t:2" })`
2. `get_compact_annotations()` lấy marker `a:n`
3. `get_component_source({ selector: "a:n", project_path: "/abs/path/to/app" })`

### 2.2 Lấy selector ổn định + action

1. `get_dom_element({ selector: "a:n" })` lấy attrs/class
2. Dựng CSS selector ngắn (ưu tiên `data-*`, `aria-*`, `role`, `name`, stable class)
3. `click/type/fill/...` với selector mới

### 2.3 Khi output “thiếu/nhầm file”

- Với `get_component_source`: truyền đúng `project_path`.
- Nếu vẫn `NOT_FOUND`: app có thể đang chạy production/minified; dùng fingerprint scan hoặc bật dev build/sourcemap.
