# blockbench-mcp

An MCP server that gives an AI agent full programmatic control of **Blockbench**:
3D modeling, procedural textures, UV, animation, codecs/export, files, plugin
management — and arbitrary JavaScript inside Blockbench when the built-in tools
aren't enough.

Transport: agent ←(stdio/JSON-RPC)→ this server ←(localhost WebSocket)→ a plugin
inside Blockbench. Zero dependencies: just Node.js and Blockbench itself.

```
┌────────────┐   stdio / MCP    ┌──────────────────┐   WebSocket   ┌─────────────────────┐
│  MCP client│ ───────────────► │ blockbench-mcp   │ ◄──────────── │ Blockbench + plugin │
│ (opencode, │ ◄─────────────── │  (this project)  │  127.0.0.1    │ Blockbench MCP Bridge│
│  Claude…)  │   JSON-RPC       │  port + token    │  connection.json             │
└────────────┘                  └──────────────────┘               └─────────────────────┘
```

---

## Requirements

- **Node.js ≥ 18** (tested on 22).
- **Blockbench Desktop ≥ 4.9** (tested on 5.2.1). The web build won't work — the
  plugin uses the desktop app's file layer and Node modules.

## Quick start

From the project folder:

```powershell
node install.js --register
```

This will:

1. Copy the plugin `blockbench_mcp.js` into Blockbench's plugins folder.
2. Add it to `StateMemory.installed_plugins` (Blockbench does not auto-scan the
   folder) and load it immediately.
3. If Blockbench isn't running (or is running without a debug port), relaunch it
   with `--remote-debugging-port` and inject the plugin over CDP.

> Prefer doing it by hand? Copy `plugin/build/blockbench_mcp.js` into the
> Blockbench plugins folder and drag the file into the Blockbench window once,
> confirming the install. `--force` lets the installer restart a running
> Blockbench (unsaved changes would be lost).

Then register the server with your client:

```powershell
node install.js opencode      # or cursor / claude / windsurf / vscode / gemini / cline
node install.js --all         # all of them
node install.js --print-config   # show configs without writing anything
```

Check everything is in place:

```powershell
node install.js --status
```

Open (or restart) your MCP client and ask the agent to call **`bb_status`** — it
should return the Blockbench version and a project summary.

## The agent's workflow (baked into the server instructions)

1. `bb_status` — learn the format, mode and contents.
2. `bb_new_project` / `bb_open_model` — create or open a project.
3. Build: `bb_add_cube`, `bb_add_group`, `bb_add_mesh`. Repeat parts with
   `bb_array_elements`, symmetry with `bb_mirror_elements` (not hand-placed copies).
4. Textures: `bb_create_texture` / `bb_generate_texture` (seeded ops), refine with
   `bb_draw_texture` / `bb_paint_pixels`, assign with `bb_set_face_texture`,
   verify with `bb_get_texture_pixel`.
5. **Look at the result**: `bb_review` renders the model from 4–6 angles into a
   single contact sheet (the path is returned; the agent reads the image and fixes
   proportions/textures). `bb_set_view` + `bb_screenshot` are available too.
6. `bb_validate` → fix findings → `bb_export_model` (bbmodel, java_block, bedrock,
   gltf, obj, fbx, stl, collada, skin…).
7. `bb_execute_js` for arbitrary JS inside Blockbench; `bb_step` batches several
   calls in one round trip.

## Tools (69)

### Utility
`bb_status`, `bb_execute_js`, `bb_step` (batch; later steps can reference earlier
results with `"$0.element.uuid"`)

### Project and codecs
`bb_new_project`, `bb_open_model`, `bb_save_project`, `bb_export_model`,
`bb_project_info`, `bb_set_project`

### Files
`bb_read_file`, `bb_write_file`, `bb_list_dir`, `bb_glob`, `bb_file_info`,
`bb_mkdir`, `bb_delete_path`, `bb_request_fs`
> Reads and writes go through Blockbench's file layer and **need no permission**.
> Directory listing, stat, mkdir and delete need a one-time plugin permission for
> the filesystem — Blockbench asks on first use; click "Always allow for this plugin".

### Model
`bb_list_elements`, `bb_add_cube`, `bb_add_group`, `bb_add_mesh`, `bb_edit_mesh`,
`bb_add_element`, `bb_set_element`, `bb_transform_elements`, `bb_array_elements`,
`bb_mirror_elements`, `bb_duplicate_elements`, `bb_delete_elements`,
`bb_reparent_elements`, `bb_select_elements`, `bb_group_elements`,
`bb_set_face_texture`, `bb_set_face_uv`, `bb_auto_uv`, `bb_validate`

### Textures
`bb_list_textures`, `bb_create_texture`, `bb_generate_texture`, `bb_draw_texture`,
`bb_paint_pixels`, `bb_get_texture_pixel`, `bb_import_texture`, `bb_export_texture`,
`bb_set_texture_properties`, `bb_resize_texture`, `bb_delete_texture`

Material presets: `wood`, `planks`, `stone`, `cobble`, `metal`, `dirt`, `grass`,
`leaves`, `bricks`, `fabric`, `skin`, `gem`, `noise`, `gradient` — set with the
`preset` field; your own `ops` run on top. Drawing ops (`ops`) support: `fill`,
`noise`, `cells`, `gradient`, `radial`, `rect`, `circle`, `ellipse`, `line`,
`checker`, `stripes`, `border`, `vignette`, `scatter`, `pixel`, `pixels`, `text`,
`adjust`, `replace`, `blend`. Everything is deterministic for a given `seed`.

### Animation
`bb_list_animations`, `bb_create_animation`, `bb_set_animation`,
`bb_delete_animation`, `bb_add_keyframe`, `bb_delete_keyframe`, `bb_play_animation`

### UI / rendering
`bb_set_mode`, `bb_set_view`, `bb_run_action`, `bb_list_actions`, `bb_notify`,
`bb_screenshot`, `bb_review`

### Plugins and settings
`bb_list_plugins`, `bb_install_plugin`, `bb_uninstall_plugin`, `bb_reload_plugin`,
`bb_list_settings`, `bb_set_setting`

### Host tools (work even with Blockbench closed)
`bb_bridge_status`, `bb_setup`, `bb_reconnect`

## Examples

```jsonc
// procedural 64×64 texture
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
// the same, with a material preset
{ "tool": "bb_generate_texture", "arguments": { "preset": "wood", "name": "wood", "width": 64, "height": 64 } }
```

```jsonc
// a deterministic row of cubes
{ "tool": "bb_array_elements", "arguments": {
  "targets": ["step-original-uuid"], "axis": "x", "count": 5, "offset": 16, "names": "step_{i}" } }
```

```jsonc
// batch with a result reference: add a cube, then texture it by its new uuid
{ "tool": "bb_step", "arguments": { "steps": [
  { "tool": "bb_add_cube", "arguments": { "name": "spike", "from": [0,20,0], "size": [4,4,4] } },
  { "tool": "bb_set_face_texture", "arguments": { "targets": ["$0.element.uuid"], "texture": "stone" } }
] } }
```

```jsonc
// "do anything": raw JavaScript inside Blockbench
{ "tool": "bb_execute_js", "arguments": {
  "code": "return Cube.all.map(c => c.name + ' @ ' + JSON.stringify(c.from));" } }
```

Sample output lives in `examples/`: a quadruped mob (`toxin_beast`) built entirely
through this MCP — `.bbmodel`, a 6-angle review sheet and a hero render. Open the
`.bbmodel` in Blockbench or look at the PNGs to see what comes out of the box.

## Security

- The server listens only on `127.0.0.1` on a random port and accepts connections
  only with a matching token (regenerated on every start). The endpoint is
  loopback-only and token-gated.
- `bb_execute_js`, `bb_run_action` and `bb_install_plugin` can run arbitrary code
  and install third-party plugins — that is the intended functionality. Don't point
  this server at a Blockbench instance you don't trust, and don't install plugins
  from untrusted sources.

## Project layout

```
blockbench-MCP/
├─ plugin/
│  ├─ src/                  plugin sources (concatenated into one file)
│  │  ├─ 00-core.js         helpers, ref resolution, undo, fs, sanitize
│  │  ├─ 10-textures.js     procedural texture engine (seeded ops) + presets
│  │  ├─ 20-tools-core.js   status, execute_js, projects, files, screenshots
│  │  ├─ 30-tools-model.js  elements, transforms, arrays, UV, validate
│  │  ├─ 40-tools-texture.js
│  │  ├─ 50-tools-animation.js
│  │  ├─ 60-tools-plugins.js
│  │  └─ 99-boot.js         WS client, plugin registration, tool registry
│  └─ build/blockbench_mcp.js   built plugin (this is what Blockbench loads)
├─ src/
│  ├─ index.js              MCP server (stdio) + host tools
│  ├─ mcp.js                MCP protocol implementation (zero-dep)
│  ├─ ws.js                 WebSocket server (RFC 6455, zero-dep)
│  ├─ bridge.js             bridge to the plugin + connection.json
│  ├─ setup.js              plugin install + client configs
│  └─ register.js           CDP-based plugin registration
├─ install.js               installer / config CLI
├─ examples/                a model built through the MCP
└─ test/  ws.js · offline.js · live.js · call.js · eval.js
```

## Development

```powershell
node plugin/build.js     # rebuild the plugin (validates syntax and schemas)
node test/ws.js          # WebSocket server test
node test/offline.js     # MCP protocol without Blockbench
node test/live.js        # end-to-end test in a live Blockbench (must be running)
node test/call.js bb_status       # one-off tool call
node test/eval.js "Plugins.registered"   # evaluate JS in Blockbench over CDP
```

After editing the plugin: `node plugin/build.js`, then `node install.js --plugin`
and `node install.js --register --no-plugin` (hot reload without restarting
Blockbench — only if it's running with a debug port).

## Troubleshooting

- **`bb_bridge_status` → `connected: false`.** The plugin isn't loaded or
  Blockbench is closed. Run `node install.js --register` and make sure
  "Blockbench MCP Bridge" is listed among Blockbench's plugins.
- **The plugin file is in the folder but Blockbench doesn't see it.** A file in
  `plugins/` alone isn't loaded — it must be recorded in
  `StateMemory.installed_plugins`, which is what `--register` (or dragging the file
  into the window) does.
- **FS tools ask for permission.** That's expected and one-time; or call
  `bb_request_fs`.
- **Format/version mismatch.** See available formats and codecs in `bb_status` and
  `bb_project_info`.

License: MIT.
