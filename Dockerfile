# Build the client bundle and the server in one place, then ship only the two
# files they produce — the runtime image carries no node_modules and no source.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/server.js ./server.js
COPY --from=build /app/dist/index.html ./index.html

# The tokens live in /data. Owned by the unprivileged node user so nothing in
# the container runs as root near them.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5178
CMD ["node", "server.js"]
