# Theater panel as a Home Assistant add-on. Same app as the upstream image, but it runs as root
# (the Supervisor mounts /data owned by root) and starts through addon-start.mjs, which maps the
# add-on's options and Supervisor token onto the panel's environment variables.
# Built from the repository root: docker build -f theater_panel/Dockerfile .
FROM node:26-alpine

ARG BUILD_VERSION=dev
ARG BUILD_TIME=
ARG BUILD_ARCH=aarch64

LABEL io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}" \
      io.hass.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/spamolution-dotcom/theater-panel"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    CACHE_DIR=/data/cache \
    BUILD_VERSION=$BUILD_VERSION \
    BUILD_TIME=$BUILD_TIME

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY web ./web

EXPOSE 8787 6053
CMD ["node", "server/addon-start.mjs"]
