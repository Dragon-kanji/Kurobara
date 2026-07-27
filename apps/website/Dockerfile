# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
RUN npm ci --workspace @kurobara/website --include-workspace-root=false
RUN npm run build --workspace @kurobara/website

FROM ${NGINX_IMAGE} AS runtime
COPY apps/website/security-headers.conf /etc/nginx/security-headers.conf
COPY apps/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/website/dist/ /usr/share/nginx/html/

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:8080/healthz || exit 1
