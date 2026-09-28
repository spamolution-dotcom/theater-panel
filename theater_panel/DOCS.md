# Theater Panel

A home theater wall panel, forked from [davidcoulson/theater-panel](https://github.com/davidcoulson/theater-panel)
and being adapted to Stremio + Google TV instead of Plex. Phase 1: the panel runs as an add-on and
connects to Home Assistant; there is no library data yet.

## Install

1. Settings > Add-ons > Add-on store > ⋮ > Repositories, add
   `https://github.com/spamolution-dotcom/theater-panel`.
2. Install **Theater Panel**, set the options below, start it.
3. Open `http://homeassistant.local:8787` (or the Green's IP) on the wall tablet.

## Options

| Option | What it does |
| --- | --- |
| `admin_password` | Enables the settings page at `/admin`. |
| `allow_open` | `true` = anyone on the LAN can use the panel without a key. |
| `trust_networks` | CIDRs that skip the key, e.g. `192.168.107.0/24`. |
| `image_cache_mb` | Poster cache limit on the Green's storage (default 300). |
| `tmdb_api_key` | Optional; recommendations and holiday shelves. |

With neither `allow_open` nor a matching `trust_networks`, the panel makes a key on first start and
shows it on `/admin`; open the panel once with `?key=<key>` and the browser keeps a cookie.

## The panel as a Home Assistant device

Settings > Devices & services > Add integration > ESPHome, host = the Green's IP, port 6053.
