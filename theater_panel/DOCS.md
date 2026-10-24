# Theater Panel

A home cinema control panel for a wall tablet and your phone: browse Stremio and see what's playing
on Google TV, start the cinema with one tap, run scenes (Pre-show, Movie time, Intermission,
Lights up, All off) and watch it all come up on a warm-up screen. Forked from
[davidcoulson/theater-panel](https://github.com/davidcoulson/theater-panel) and adapted to
Stremio + Google TV.

The full guide, with screenshots of every screen, is in the
[repository README](https://github.com/spamolution-dotcom/theater-panel#readme).

## Install

1. Settings > Add-ons > Add-on store > ⋮ > Repositories, add
   `https://github.com/spamolution-dotcom/theater-panel`.
2. Install **Theater Panel**, set the options below, start it.
3. Open `http://homeassistant.local:8787` on the wall tablet, and `/remote` on your phone.
4. Load `ha/theater-stremio.yaml` from the repository into your HA (scripts, helpers, lights
   automation), then sign in at `/admin` and point the panel at your entities.

## Options

| Option | What it does |
| --- | --- |
| `stremio_email`, `stremio_password` | Your Stremio account. The add-on signs in once and keeps the session key in `/data`. |
| `admin_password` | Enables the settings page at `/admin`. |
| `allow_open` | `true` = anyone on the network can use the panel without a key. |
| `trust_networks` | Comma-separated ranges that skip the key, e.g. `192.168.1.0/24`. For Tailscale add `100.64.0.0/10` and `172.30.32.1`. |
| `public_url` | The panel's own address as other devices see it (speaker sounds, QR codes). |
| `preroll` | A short "lights down" swell before a film (adds ~16 s). |
| `dashboard_url`, `hallway_return_minutes` | Where the hallway screen's Dashboard button goes, and after how many idle minutes (cinema off) it goes back there by itself. |
| `image_cache_mb` | Poster cache limit (default 300). |
| `tmdb_api_key` | Optional; recommendations and holiday shelves. |
| `music_assistant_token` | Optional. A long-lived token made in Music Assistant (Settings → Profile). Gives the iPad's Music tab its For you page: Top picks, Recently played, Recently added albums and genres. |
| `music_assistant_url` | Optional. Where Music Assistant is, if not the Music Assistant app on this Home Assistant (e.g. `http://192.168.1.10:8095`). |

With neither `allow_open` nor a matching `trust_networks`, the panel makes a key on first start and
shows it on `/admin`; open the panel once with `?key=<key>` and the browser keeps a cookie.

## The panel as a Home Assistant device

Settings > Devices & services > Add integration > ESPHome, host = your HA's IP, port 6053. You get
buttons for every scene, Mystery box and Surprise me, sensors for what's on, and actions to move the
panels to a screen.
