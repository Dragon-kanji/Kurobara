# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
RUN npm ci
RUN node scripts/build-runtime.mjs --output /tmp/kurobara-runtime

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /opt/kurobara
COPY --from=build --chown=node:node /tmp/kurobara-runtime/ ./
COPY --from=build --chown=node:node /src/examples/ ./examples/
COPY --chown=node:node deploy/self-host/worker-entrypoint.sh /usr/local/bin/kurobara-worker-entrypoint
USER node

FROM runtime AS api
EXPOSE 3000
CMD ["node", "bin/api.mjs"]

FROM runtime AS worker
ENTRYPOINT ["/usr/local/bin/kurobara-worker-entrypoint"]
CMD ["node", "bin/worker.mjs"]

FROM runtime AS cli
ENTRYPOINT ["node", "/opt/kurobara/bin/cli.mjs"]
