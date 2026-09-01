# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Preview Gateway uses FFmpeg for derived video previews and frame strips. Keep
# it in the runtime image explicitly; ffmpeg-static may not run its install
# hook in every Bun/npm build environment.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/firebase-applet-config.json ./firebase-applet-config.json

USER node
EXPOSE 8080

CMD ["node", "dist/server.cjs"]
