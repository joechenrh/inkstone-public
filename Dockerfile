# Build and run Inkstone.
#
# -slim plus git and openssh-client, which the runtime needs: simple-git shells out to `git`
# for every vault operation, and the vault's Push button uses ssh. -slim keeps the image ~800MB
# smaller than the full node image.
#
# Hosts that cannot reach the usual endpoints can point every one of them elsewhere without
# editing this file: NODE_IMAGE for the base image, NPM_REGISTRY for the package registry, and
# DEBIAN_MIRROR for apt. All three default to the official ones, so the build is portable.
# Node 24: the version this is built and run against.
ARG NODE_IMAGE=node:24-slim

# Where a host reaches the registry slowly — 50s per request turns the install into a 20-minute
# coin flip — pass a mirror. The default stays official so the build is portable.
ARG NPM_REGISTRY=https://registry.npmjs.org/

# And the same for apt. Empty leaves the image's own sources alone, which is the right default.
ARG DEBIAN_MIRROR=

# The commit shown in Settings. Empty in a build that is not a deploy, and the bundle then says
# `dev` — an honest word rather than a plausible sha that is not the one running.
ARG GIT_SHA=

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
ENV npm_config_registry=${NPM_REGISTRY}
# corepack fetches the pinned pnpm from npm and ignores npm_config_registry.
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
WORKDIR /app
RUN corepack enable && pnpm --version
# .npmrc carries enable-pre-post-scripts=true, without which `prebuild` never runs and the
# self-hosted Vditor assets are silently missing from the bundle.
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
# Re-declared inside the stage: a global ARG is not visible to a build stage unless it asks.
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}
# Node sizes its own heap from the machine's memory, which on a small host is about 1 GB — and a
# bundle with a diagram library in it needs more than that. Measured on a 1.8 GB host: the build
# died with `FATAL ERROR: … JavaScript heap out of memory`, exit 134, *after* swap had been added,
# so the kernel was no longer the one refusing. This is the ceiling, not an allocation: a build
# that does not need it does not take it, and where the memory is not there, swap carries it.
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN pnpm build

FROM ${NODE_IMAGE}
ARG NPM_REGISTRY
ENV npm_config_registry=${NPM_REGISTRY}
# corepack fetches the pinned pnpm from npm and ignores npm_config_registry.
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
WORKDIR /app
ENV NODE_ENV=production
ARG DEBIAN_MIRROR
RUN set -eux; \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
        [ -f "$f" ] && sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g; s|security.debian.org|$DEBIAN_MIRROR|g" "$f" || true; \
      done; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends git openssh-client ca-certificates; \
    rm -rf /var/lib/apt/lists/*
RUN corepack enable && pnpm --version
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=build /app/dist ./dist
# The complete CJK faces, server-side only and never served to a browser: each shared note gets a
# face cut to its own characters, and cutting from the whole face costs nothing on the wire while
# covering the characters the shipped subset drops. See src/server/share/font.ts.
COPY --from=build /app/assets ./assets

# Bound to loopback inside the container's namespace would be unreachable from the host, so
# the container listens on all of ITS interfaces and the host publishes it to 127.0.0.1 only
# (see the systemd unit). The app is never directly reachable from outside.
ENV LISTEN_ADDR=0.0.0.0
ENV PORT=7654
EXPOSE 7654

CMD ["node", "dist/server/main.js"]
