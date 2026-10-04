# blockbench-mcp

MCP-сервер, который даёт ИИ-агенту полный программный контроль над **Blockbench**:
3D-моделирование, процедурные текстуры, UV, анимации, кодеки/экспорт, файлы,
установка и перезагрузка плагинов — и произвольный JavaScript внутри Blockbench,
если готовых инструментов не хватает.

Транспорт: агент ←(stdio/JSON-RPC)→ этот сервер ←(localhost WebSocket)→ плагин
внутри Blockbench. Ноль зависимостей: только Node.js и сам Blockbench.

```
┌────────────┐   stdio / MCP    ┌──────────────────┐   WebSocket   ┌─────────────────────┐
│  MCP client│ ───────────────► │ blockbench-mcp   │ ◄──────────── │ Blockbench + плагин │
│ (opencode, │ ◄─────────────── │  (этот проект)   │  127.0.0.1    │ Blockbench MCP Bridge│
│  Claude…)  │   JSON-RPC       │  порт + токен    │  connection.json             │
└────────────┘                  └──────────────────┘               └─────────────────────┘
```

---

## Требования

- **Node.js ≥ 18** (проверено на 22).
- **Blockbench Desktop ≥ 4.9** (проверено на 5.2.1). Веб-версия не подойдёт — плагин
  использует файловый слой и Node-модули десктопного приложения.

## Быстрый старт

Из папки проекта:

```powershell
node install.js --register
```

Что это делает:

1. Копирует плагин `blockbench_mcp.js` в папку плагинов Blockbench.
2. Добавляет его в `StateMemory.installed_plugins` (иначе Blockbench его не
   подхватит при запуске) и сразу загружает.
3. Если Blockbench не запущен (или запущен без отладочного порта) — перезапускает
   его с `--remote-debugging-port`, чтобы внедрить плагин через CDP.

> Если не хочется автоматики: скопируйте `plugin/build/blockbench_mcp.js` в папку
> плагинов Blockbench и один раз перетащите файл в окно Blockbench, подтвердив
> установку. Флаг `--force` разрешает перезапустить уже запущенный Blockbench
> (несохранённые изменения будут потеряны).

Затем пропишите сервер в конфиг клиента:

```powershell
node install.js opencode      # или cursor / claude / windsurf / vscode / gemini / cline
node install.js --all         # сразу все
node install.js --print-config   # только показать, ничего не писать
```

Проверить, что всё на месте:

```powershell
node install.js --status
```

Откройте (или перезапустите) MCP-клиент и попросите агента вызвать **`bb_status`** —
он должен вернуть версию Blockbench и сводку проекта.

## Маршрут агента (что заложено в instructions сервера)

1. `bb_status` — узнать формат, режим, содержимое.
2. `bb_new_project` / `bb_open_model` — создать или открыть проект.
3. Строить: `bb_add_cube`, `bb_add_group`, `bb_add_mesh`. Повторяющиеся элементы —
   через `bb_array_elements`, симметрию — через `bb_mirror_elements` (а не копиями вручную).
4. Текстуры: `bb_create_texture` / `bb_generate_texture` (детерминированные ops),
   правки — `bb_draw_texture` / `bb_paint_pixels`, назначение — `bb_set_face_texture`,
   проверка — `bb_get_texture_pixel`.
5. **Посмотреть на результат**: `bb_review` — рендер модели с 4–6 ракурсов в одну
   картинку (возвращает путь к PNG; агент её читает и правит пропорции/текстуры).
   При необходимости — `bb_set_view` + `bb_screenshot`.
6. `bb_validate` → исправить замечания → `bb_export_model` (bbmodel, java_block,
   bedrock, gltf, obj, fbx, stl, collada, skin…).
7. `bb_execute_js` — произвольный JS внутри Blockbench; `bb_step` — несколько
   вызовов за один round trip.

## Инструменты (69)

### Служебные
`bb_status`, `bb_execute_js`, `bb_step` (батч; последующие шаги могут ссылаться на
результаты предыдущих через `"$0.element.uuid"`)

### Проект и кодеки
`bb_new_project`, `bb_open_model`, `bb_save_project`, `bb_export_model`,
`bb_project_info`, `bb_set_project`

### Файлы
`bb_read_file`, `bb_write_file`, `bb_list_dir`, `bb_glob`, `bb_file_info`, `bb_mkdir`,
`bb_delete_path`, `bb_request_fs`
> Чтение/запись идут через файловый слой Blockbench и **не требуют прав**. Для
> листинга, stat, mkdir и удаления нужно разово разрешение плагина на ФС — при
> первом вызове Blockbench спросит, нажмите «Always allow for this plugin».

### Модель
`bb_list_elements`, `bb_add_cube`, `bb_add_group`, `bb_add_mesh`, `bb_edit_mesh`,
`bb_add_element`,
`bb_set_element`, `bb_transform_elements`, `bb_array_elements`, `bb_mirror_elements`,
`bb_duplicate_elements`, `bb_delete_elements`, `bb_reparent_elements`,
`bb_select_elements`, `bb_group_elements`, `bb_set_face_texture`, `bb_set_face_uv`,
`bb_auto_uv`, `bb_validate`

### Текстуры
`bb_list_textures`, `bb_create_texture`, `bb_generate_texture`, `bb_draw_texture`,
`bb_paint_pixels`, `bb_get_texture_pixel`, `bb_import_texture`, `bb_export_texture`,
`bb_set_texture_properties`, `bb_resize_texture`, `bb_delete_texture`

Готовые пресеты материалов: `wood`, `planks`, `stone`, `cobble`, `metal`, `dirt`,
`grass`, `leaves`, `bricks`, `fabric`, `skin`, `gem`, `noise`, `gradient` — задаются
полем `preset`; поверх можно наложить свои `ops`. Операции рисования (`ops`)
поддерживают: `fill`, `noise`, `cells`, `gradient`,
`radial`, `rect`, `circle`, `ellipse`, `line`, `checker`, `stripes`, `border`,
`vignette`, `scatter`, `pixel`, `pixels`, `text`, `adjust`, `replace`, `blend`.
Всё детерминировано по `seed`.

### Анимация
`bb_list_animations`, `bb_create_animation`, `bb_set_animation`, `bb_delete_animation`,
`bb_add_keyframe`, `bb_delete_keyframe`, `bb_play_animation`

### UI / рендер
`bb_set_mode`, `bb_set_view`, `bb_run_action`, `bb_list_actions`, `bb_notify`, `bb_screenshot`, `bb_review`

### Плагины и настройки
`bb_list_plugins`, `bb_install_plugin`, `bb_uninstall_plugin`, `bb_reload_plugin`,
`bb_list_settings`, `bb_set_setting`

### Хост-инструменты (работают без Blockbench)
`bb_bridge_status`, `bb_setup`, `bb_reconnect`

## Примеры вызовов

```jsonc
// процедурная текстура 64×64
{ "tool": "bb_generate_texture", "arguments": {
  "name": "stone", "width": 64, "height": 64, "seed": 7,
  "ops": [
    { "op": "fill",  "color": "#3a3f46" },
    { "op": "noise", "color": "#22262b", "color2": "#6b7480", "scale": 3, "octaves": 5 },
    { "op": "cells", "cell_size": 10, "color": "#000000", "color2": "#ffffff", "edge": true },
    { "op": "vignette", "strength": 0.4 }
  ] } }
```

```jsonc
// детерминированный ряд кубов
{ "tool": "bb_array_elements", "arguments": {
  "targets": ["step-original-uuid"], "axis": "x", "count": 5, "offset": 16, "names": "step_{i}" } }
```

```jsonc
// «сделать что угодно» — прямой JS внутри Blockbench
{ "tool": "bb_execute_js", "arguments": {
  "code": "return Cube.all.map(c => c.name + ' @ ' + JSON.stringify(c.from));" } }
```

## Безопасность

- Сервер слушает только `127.0.0.1` на случайном порту и пускает соединения
  только с совпадающим токеном (токен генерируется заново при каждом запуске и
  кладётся в `connection.json`).
- `bb_execute_js`, `bb_run_action` и `bb_install_plugin` дают возможность выполнять
  произвольный код и ставить сторонние плагины — это задуманная функциональность.
  Не подключайте этот сервер к Blockbench, к которому у вас нет доверия, и не
  ставьте плагины из недоверенных источников.

## Примеры

В `examples/` лежит модель, собранная целиком через этот MCP (четвероногий моб
`toxin_beast`): `toxin_beast.bbmodel`, обзорный лист `toxin_beast_review.png`
(6 ракурсов) и герой-рендер `toxin_beast.png`. Откройте `.bbmodel` в Blockbench
или посмотрите картинки, чтобы оценить, что выходит «из коробки».

## Устройство проекта

```
blockbench-MCP/
├─ plugin/
│  ├─ src/                  исходники плагина (собираются в один файл)
│  │  ├─ 00-core.js         хелперы, разрешение ссылок, undo, fs, sanitize
│  │  ├─ 10-textures.js     движок процедурных текстур (seeded ops)
│  │  ├─ 20-tools-core.js   статус, execute_js, проекты, файлы, скриншоты
│  │  ├─ 30-tools-model.js  элементы, трансформации, массивы, UV, validate
│  │  ├─ 40-tools-texture.js
│  │  ├─ 50-tools-animation.js
│  │  ├─ 60-tools-plugins.js
│  │  └─ 99-boot.js         WS-клиент, регистрация плагина, реестр
│  └─ build/blockbench_mcp.js   собранный плагин (его грузит Blockbench)
├─ src/
│  ├─ index.js              MCP-сервер (stdio) + хост-инструменты
│  ├─ mcp.js                реализация протокола MCP (zero-dep)
│  ├─ ws.js                 WebSocket-сервер (RFC 6455, zero-dep)
│  ├─ bridge.js             связка с плагином + connection.json
│  ├─ setup.js              установка плагина и конфиги клиентов
│  └─ register.js           регистрация плагина через CDP
├─ install.js               CLI установки/конфигурации
└─ test/  ws.js · offline.js · live.js · call.js
```

## Разработка

```powershell
node plugin/build.js     # пересобрать плагин (проверяет синтаксис и схемы)
node test/ws.js          # тест WebSocket-сервера
node test/offline.js     # MCP-протокол без Blockbench
node test/live.js        # сквозной тест в живом Blockbench (нужен запущенный)
node test/call.js bb_status   # разовый вызов инструмента
```

После правки плагина: `node plugin/build.js`, затем `node install.js --plugin` и
`node install.js --register --no-plugin` (горячая перезагрузка без перезапуска
Blockbench — только если он запущен с отладочным портом).

## Диагностика

- **`bb_bridge_status` → `connected: false`.** Плагин не загружен или Blockbench
  закрыт. Запустите `node install.js --register`, убедитесь, что в Blockbench в
  списке плагинов есть «Blockbench MCP Bridge».
- **Плагин был в папке, но Blockbench его не видит.** Файл в папке `plugins/` сам
  по себе не грузится — нужна запись в `StateMemory.installed_plugins`; это и
  делает `--register` (или перетаскивание файла в окно).
- **Инструменты ФС просят разрешение.** Это нормально и нужно один раз; либо
  вызывайте `bb_request_fs`.
- **Конфликт версий формата.** Доступные форматы и кодеки смотрите в `bb_status`
  и `bb_project_info`.

Лицензия: MIT.
