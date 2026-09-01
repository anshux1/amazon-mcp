FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src/widgets/package.json src/widgets/pnpm-lock.yaml ./src/widgets/
RUN pnpm install --frozen-lockfile
RUN pnpm --dir src/widgets install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT_TYPE=http
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/widgets/out ./src/widgets/out
COPY --from=build /app/src/widgets/widget-manifest.json ./src/widgets/widget-manifest.json

EXPOSE 3000
CMD ["node", "dist/index.js"]
