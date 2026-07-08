FROM oven/bun:1.3-slim

COPY server.ts /app/server.ts

# The exec seam runs `sh -c <command>` with the server's cwd. /app is
# root-owned (WORKDIR creates it as root), so give the bun user a writable
# workspace and make it the cwd — file tools and relative paths resolve here.
RUN mkdir -p /workspace && chown bun:bun /workspace

USER bun
WORKDIR /workspace

EXPOSE 8080
CMD ["bun", "/app/server.ts"]
