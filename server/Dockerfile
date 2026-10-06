FROM node:20-alpine AS deps
WORKDIR /app
# better-sqlite3 (reads the Forward Scan database) is a native module:
# prebuilt musl binaries normally download; these tools are the fallback
# compile path so a missing prebuild never breaks the image.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.js"]
