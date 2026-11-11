FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/me >/dev/null 2>&1 || [ $? -eq 8 ]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
