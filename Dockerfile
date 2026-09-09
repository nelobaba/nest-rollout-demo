# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# APP_VERSION / FAIL_HEALTH are provided at build or run time (see below).
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]