/* =============================================================================
 * Plugin management and settings access.
 *
 * Installing code runs it inside Blockbench, so this is the power tool the user
 * asked for: the agent can add, load, reload and remove plugins. Anything
 * installed here is written to Blockbench's plugins folder and recorded in
 * StateMemory.installed_plugins so it survives a restart.
 * ========================================================================== */

tool('bb_list_plugins', 'List plugins',
  'List every Blockbench plugin that is present, with id, version, source, install state and whether it can be reloaded.',
  { type: 'object', properties: {} },
  function () {
    var all = (root.Plugins && root.Plugins.all) || [];
    var installed = (root.Plugins && root.Plugins.installed) || [];
    return {
      count: all.length,
      plugins: all.map(function (p) {
        return {
          id: p.id,
          title: p.title,
          version: p.version,
          author: p.author,
          description: p.description,
          source: p.source,
          installed: !!p.installed,
          disabled: !!p.disabled,
          path: p.path || undefined,
          reloadable: typeof p.isReloadable === 'function' ? !!p.isReloadable() : false,
          registered: !!(root.Plugins.registered && root.Plugins.registered[p.id]),
        };
      }),
      installed_records: installed.map(function (i) { return { id: i.id, version: i.version, source: i.source, path: i.path, disabled: i.disabled }; }),
      plugins_dir: root.Plugins ? root.Plugins.path : null,
    };
  });

tool('bb_install_plugin', 'Install a plugin',
  'Install a Blockbench plugin from source code, a local file, or a URL. The code is written to the plugins folder, recorded so it loads on startup, and loaded immediately. Executes third-party code inside Blockbench.',
  {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Full plugin JavaScript source.' },
      path: { type: 'string', description: 'Local .js file to install.' },
      url: { type: 'string', description: 'URL of a .js plugin file.' },
      id: { type: 'string', description: 'Plugin id (required unless it can be read from the code).' },
      version: { type: 'string', default: '1.0.0' },
    },
  },
  async function (args) {
    if (!root.Plugins || !root.Plugin) fail('The plugin system is unavailable in this build.');
    var code = args.code;
    if (!code && args.path) code = await readText(resolvePath(args.path));
    if (!code && args.url) {
      var res = await fetch(args.url);
      if (!res.ok) fail('Could not download the plugin: HTTP ' + res.status);
      code = await res.text();
    }
    if (!code) fail('Provide "code", "path" or "url".');
    var id = args.id || sniffPluginId(code);
    if (!id) fail('Could not determine the plugin id.', 'Pass "id" explicitly, or make sure the code calls Plugin.register("<id>", ...).');

    var target = (root.Plugins.path || '') + id + '.js';
    writeFile(target, code, 'text');

    var installed = (root.Plugins.installed || []).filter(function (p) { return p && p.id !== id; });
    installed.push({ id: id, version: args.version || '1.0.0', path: target, source: 'file' });
    root.Plugins.installed = installed;
    if (root.StateMemory) { root.StateMemory.installed_plugins = installed; if (root.StateMemory.save) root.StateMemory.save('installed_plugins'); }

    var existing = root.Plugins.registered && root.Plugins.registered[id];
    if (existing && typeof existing.reload === 'function' && existing.isReloadable && existing.isReloadable()) {
      await existing.reload();
    } else {
      var instance = new root.Plugin(id, {});
      await instance.loadFromFile({ path: target, name: target, content: '' }, false);
    }
    await new Promise(function (r) { setTimeout(r, 120); });
    return { id: id, path: target, loaded: !!(root.Plugins.registered && root.Plugins.registered[id]) };
  });

function sniffPluginId(code) {
  var m = /Plugin\.register\s*\(\s*['"]([^'"]+)['"]/.exec(String(code));
  return m ? m[1] : null;
}

tool('bb_uninstall_plugin', 'Uninstall a plugin',
  'Uninstall a Blockbench plugin by id and optionally delete its file.',
  { type: 'object', properties: { id: { type: 'string' }, delete_file: { type: 'boolean', default: false } }, required: ['id'] },
  async function (args) {
    if (!root.Plugins) fail('The plugin system is unavailable.');
    var plugin = (root.Plugins.registered && root.Plugins.registered[args.id]) || (root.Plugins.all || []).find(function (p) { return p.id === args.id; });
    if (plugin && typeof plugin.uninstall === 'function') {
      await plugin.uninstall();
    } else {
      var installed = (root.Plugins.installed || []).filter(function (p) { return p && p.id !== args.id; });
      root.Plugins.installed = installed;
      if (root.StateMemory) { root.StateMemory.installed_plugins = installed; if (root.StateMemory.save) root.StateMemory.save('installed_plugins'); }
    }
    if (args.delete_file) {
      var fsMod = fsModule();
      var file = (root.Plugins.path || '') + args.id + '.js';
      if (fsMod) { try { if (fsMod.existsSync(file)) fsMod.unlinkSync(file); } catch (err) { /* best effort */ } }
    }
    return { id: args.id, uninstalled: true };
  });

tool('bb_reload_plugin', 'Reload a plugin',
  'Reload a dev/URL plugin without restarting Blockbench. Store plugins are not reloadable in place.',
  { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async function (args) {
    if (!root.Plugins) fail('The plugin system is unavailable.');
    var plugin = (root.Plugins.registered && root.Plugins.registered[args.id]) || (root.Plugins.all || []).find(function (p) { return p.id === args.id; });
    if (!plugin) fail('No plugin with id "' + args.id + '".', 'Use bb_list_plugins.');
    if (typeof plugin.reload !== 'function') fail('This plugin cannot be reloaded in place.');
    await plugin.reload();
    return { id: args.id, reloaded: true };
  });

/* --------------------------------------------------------------------------
 * Settings
 * ------------------------------------------------------------------------ */

tool('bb_list_settings', 'List Blockbench settings',
  'List user settings by id with their current values. Handy before bb_set_setting. filter matches the id.',
  { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'integer', default: 80 } } },
  function (args) {
    var settings = root.settings || {};
    var re = args.filter ? new RegExp(args.filter, 'i') : null;
    var out = [];
    for (var id in settings) {
      var s = settings[id];
      if (!s || s.value === undefined) continue;
      if (re && !re.test(id)) continue;
      out.push({ id: id, value: sanitize(s.value), type: s.type || (typeof s.value) });
      if (out.length >= (args.limit || 80)) break;
    }
    return { count: out.length, settings: out };
  });

tool('bb_set_setting', 'Change a setting',
  'Set a Blockbench user setting by id (e.g. viewport_zoom_speed, default_cube_size, shading).',
  { type: 'object', properties: { id: { type: 'string' }, value: {} }, required: ['id', 'value'] },
  function (args) {
    var s = root.settings && root.settings[args.id];
    if (!s) fail('No setting "' + args.id + '".', 'Use bb_list_settings to find ids.');
    if (typeof s.set === 'function') s.set(args.value);
    else s.value = args.value;
    return { id: args.id, value: sanitize(s.value) };
  });
