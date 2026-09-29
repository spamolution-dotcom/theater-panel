# Cinema event show (archive)

A surprise "show" for the home cinema, first run for a birthday on 29 Sep 2026. **This branch is an archive**:
it is never merged, so the Theater Panel app you run day to day does not contain any of it.

Reuse it by asking Claude to use the **cinema-event-show** skill; it points here.

## What's in it
| Where | What |
|---|---|
| `web/birthday.html`, `web/birthday/`, `server/*` (branch state) | The panel side: `/birthday` teaser page, `birthday` start/end action, Lobby "Birthday mode · End" chip, read-only `media` map for the poster |
| `event-show/card/` | Card video maker: `card.html` (timeline with `render(t)`), `render.py` (Playwright → ffmpeg), `build.sh` (card.mp4 < 10 MB + finale.jpg), example content, placeholder photos, self-hosted fonts |
| `event-show/teaser/encode_words.py` | Builds the teaser URL (words travel in `?d=`, so they live in HA, not here) |
| `event-show/ha/` | The HA helper, automation and two scripts as built, with personal bits replaced by `<placeholders>` |

Nothing personal (message, photos, names, songs) is stored in this repo.

## To run it again
1. Merge this branch's panel changes into a new branch off `main` (or cherry-pick), bump the version, deploy.
2. Recreate the HA helper, automation and scripts from `event-show/ha/` (after fixing the items below).
3. Write `card/content.js`, drop photos in `card/photos/`, run `card/build.sh`, upload `card.mp4`, `finale.jpg`
   and `poster.jpg` to HA → Media → Local media (root; no folders, ~10.5 MB per file, no JSON).
4. Test end to end **starting with the cinema off**, as on the night.

## Fix before reuse (lessons from the first run)
- **Never make the card wait for the music player.** Drop `media_player.home_theater_3` from the "cinema is up" wait.
- **The Denon's music side (HEOS / Music Assistant) drops after the media switch cuts power.** Before playing,
  reload the HEOS and Music Assistant config entries if the player is unavailable; fall back to the cinema Google Mini.
- **Add `continue_on_error: true` to the Music Assistant play step**, or one failure kills the finale and ending.
- **Projector can come up blank** (it powers on before the Streamer's picture): re-select its input / power-cycle it
  once the Streamer is on.
- Script is `mode: single` — extra taps while it waits are silently ignored.
- Keep `automation.toggle_movie_scene_in_media_room` on: it is what starts the cinema from `input_boolean.movie_scene`.
