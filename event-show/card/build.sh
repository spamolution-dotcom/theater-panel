#!/bin/sh
# Renders card.mp4 (under HA's ~10.5 MB media-upload limit) and finale.jpg from card.html + content.js.
# Needs: python3 + playwright (chromium), ffmpeg, Pillow. Real photos go in photos/ (max ~1600 px).
set -e
cd "$(dirname "$0")"
python3 render.py out                      # out_main.mp4 (hold + card) and out_still.png (finale)
ffmpeg -y -loglevel error -i out_main.mp4 -c:v libx264 -preset veryslow -crf 29 -pix_fmt yuv420p \
  -profile:v high -level 4.1 -g 150 -movflags +faststart card.mp4
python3 -c "from PIL import Image; Image.open('out_still.png').convert('RGB').save('finale.jpg', quality=92)"
ls -l card.mp4 finale.jpg                  # card.mp4 must be < 10,500,000 bytes; raise crf if not
