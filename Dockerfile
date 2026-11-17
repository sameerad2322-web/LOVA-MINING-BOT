FROM node:22-slim

WORKDIR /app

# Install dependencies and build the Vite frontend bundle
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.ts"]
