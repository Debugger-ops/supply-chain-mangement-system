# Multi-stage build: the build stage needs devDependencies (typescript) to
# compile; the runtime image only ships production dependencies + compiled JS.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
# Non-.ts assets tsc doesn't copy on its own, placed where the compiled JS
# expects them at runtime (both referenced via __dirname-relative paths):
COPY --from=builder /app/src/dashboard ./dist/dashboard
COPY --from=builder /app/src/inventory/*.lua ./dist/inventory/

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "dist/api/server.js"]
