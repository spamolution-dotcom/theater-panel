// Entry point when the panel runs as a Home Assistant add-on.
//
// The Supervisor hands the add-on its options in /data/options.json and a token for the core API
// in SUPERVISOR_TOKEN. This maps both onto the environment variables the panel already reads, then
// starts the normal server. Settings saved later on the panel's /admin page still win over these,
// exactly as they win over a container's environment.

import { readFileSync } from 'node:fs';

const OPTIONS_FILE = process.env.OPTIONS_FILE || '/data/options.json';

let options = {};
try {
  options = JSON.parse(readFileSync(OPTIONS_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`[addon] ${OPTIONS_FILE}: ${e.message}`);
}

const set = (key, value) => {
  if (value === undefined || value === null || value === '') return;
  process.env[key] = String(value);
};

// Home Assistant through the Supervisor: no long-lived token to create or rotate.
if (process.env.SUPERVISOR_TOKEN) {
  set('HA_URL', 'http://supervisor/core');
  set('HA_TOKEN', process.env.SUPERVISOR_TOKEN);
}

set('CACHE_DIR', process.env.CACHE_DIR || '/data/cache');
set('ADMIN_PASSWORD', options.admin_password);
set('TRUST_NETWORKS', options.trust_networks);
set('IMAGE_CACHE_MB', options.image_cache_mb);
set('TMDB_API_KEY', options.tmdb_api_key);
set('STREMIO_EMAIL', options.stremio_email);
set('STREMIO_PASSWORD', options.stremio_password);
if (options.allow_open === true) process.env.ALLOW_OPEN = '1';

// The update check compares against this fork's image, not the upstream one.
set('IMAGE_REPO', process.env.IMAGE_REPO || 'spamolution-dotcom/theater-panel-addon-aarch64');

console.log(`[addon] options: ${Object.keys(options).join(', ') || '(none)'}; HA via ${process.env.HA_URL || '(not set)'}`);

await import('./index.mjs');
