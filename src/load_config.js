// n8n Code node — "Load Config", mode: Run Once for All Items.
// The build script replaces __CONFIG__ with config/sources.json.
const CONFIG = __CONFIG__;
return CONFIG.sources
  .filter(s => s.enabled !== false)
  .map(source => ({ json: { settings: CONFIG.settings, source } }));
