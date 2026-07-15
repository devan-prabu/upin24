FROM node:22-alpine

WORKDIR /app

# Zero-dependency server — no npm install needed
COPY package.json server.js index.html tool.html ./

ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
