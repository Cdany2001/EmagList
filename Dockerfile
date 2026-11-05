# The site and its eMag reader. Node's standard library is the whole dependency list, so there is
# nothing to install and no lockfile to go stale -- the build is a copy.
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY index.html app.js styles.css products.json ./site/

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/emag/ping | grep -q ok || exit 1

CMD ["node", "server.js"]
