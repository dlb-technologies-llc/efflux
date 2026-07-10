# NOTE: base tag left as `1.3-slim` rather than a digest — a digest pin is a
# follow-up (needs a resolvable digest and would otherwise break builds here).
# The layer reorder below is the cache-correct part of audit #31.
FROM oven/bun:1.3-slim

# Writable workspace for the exec seam. /app is root-owned (WORKDIR creates it
# as root), so give the bun user a workspace and make it the cwd. This static
# layer sits BEFORE the source COPYs so it stays cached across server.ts edits.
RUN mkdir -p /workspace && chown bun:bun /workspace

# Install deps first (cached until package.json changes), then copy source.
# server.ts now imports `effect`, so the image carries it.
WORKDIR /app
COPY package.json /app/package.json
RUN bun install
COPY server.ts /app/server.ts

USER bun
WORKDIR /workspace

EXPOSE 8080
CMD ["bun", "/app/server.ts"]
