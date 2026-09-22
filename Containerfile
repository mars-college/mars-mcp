# Rootless-friendly image: runs as a non-root UID inside the user namespace that
# Podman maps for the `mars` account on eden2.
FROM docker.io/library/node:22-alpine

WORKDIR /app

# Install the full tree once, compile, then drop dev deps. An earlier
# `npm ci --omit=dev` pass was removed: `npm ci` wipes node_modules before
# installing, so it was rebuilt from scratch anyway and its layer survived in the
# image as a whited-out duplicate.
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# Only synthetic RBAC demonstration data. Never copy the private archive here.
COPY config/mars/resources.json ./config/mars/resources.json
COPY resources/demo/role-gated.txt ./resources/demo/role-gated.txt

# Must come after the build, or npm ci would skip devDependencies. Also stops
# Express rendering stack traces into error responses.
ENV NODE_ENV=production

USER node
EXPOSE 4400
CMD ["node", "--experimental-sqlite", "dist/index.js"]
