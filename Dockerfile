FROM node:20-slim
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8080 HOSTED=1
EXPOSE 8080
USER node
CMD ["node", "server.js"]
