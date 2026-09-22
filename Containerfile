# Rootless-friendly image: runs as a non-root UID inside the user namespace that
# Podman maps for the `mars` account on eden2.
FROM docker.io/library/node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
# Dev deps are needed only to compile; drop them from the final layer.
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

USER node
EXPOSE 4400
CMD ["node", "dist/index.js"]
