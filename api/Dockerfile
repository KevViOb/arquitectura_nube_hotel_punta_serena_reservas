# API REST del Hotel Punta Serena
FROM node:24.22-alpine3.24

WORKDIR /app
ENV NODE_ENV=production

# Primero las dependencias, para aprovechar la caché de Docker.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# El proceso no corre como root.
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
