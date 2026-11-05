# The site, its eMag reader and the small database behind the budget page. The Node standard
# library is the whole dependency list, so there is nothing to install and no lockfile to go
# stale -- the build is a copy.
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY lib/ ./lib/
COPY index.html app.js styles.css products.json ./site/

# The one writable place. Compose mounts a volume over it; this line only makes sure the
# directory exists and belongs to the user the server runs as.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

ENV PORT=8080 NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/emag/ping | grep -q ok || exit 1

CMD ["node", "server.js"]
