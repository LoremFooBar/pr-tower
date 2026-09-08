# Build the client bundle and the server in one place, then ship only the two
# files they produce — the runtime image carries no node_modules and no source.
FROM node:24-alpine AS build
WORKDIR /app

# pnpm's lockfile records integrity hashes and names no registry, so one
# argument redirects the whole install. Behind a proxy that re-signs TLS, point
# this at the mirror that proxy trusts: the container has no corporate CA, so
# registry.npmjs.org fails there with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry "$NPM_REGISTRY" && npm install -g pnpm@10.20.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm config set registry "$NPM_REGISTRY" && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/server.js ./server.js
COPY --from=build /app/dist/index.html ./index.html
# The manifest and its icons: a browser will not offer an install without them.
COPY --from=build /app/dist/manifest.webmanifest ./manifest.webmanifest
COPY --from=build /app/dist/icon-*.png ./

# The tokens live in /data. Owned by the unprivileged node user so nothing in
# the container runs as root near them.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5178
CMD ["node", "server.js"]
