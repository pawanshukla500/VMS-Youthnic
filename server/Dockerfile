FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Drop root: the API only listens on 8080 and writes the desktop-download
# dir, so the stock `node` user is sufficient. Fewer container-escape paths
# if a dependency is ever exploited.
RUN mkdir -p /app/downloads && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
