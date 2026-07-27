# Kurobara website

Static, no-tracking landing page for `kurobara.systems`.

```sh
npm run dev --workspace @kurobara/website
npm run typecheck --workspace @kurobara/website
npm run build --workspace @kurobara/website
```

The production image is built from the repository root:

```sh
docker build -f apps/website/Dockerfile -t kurobara-website:local .
docker run --rm -p 8080:8080 kurobara-website:local
```

The container is static, unprivileged, health-checked, and intended to sit
behind Coolify and Cloudflare. It has no runtime secrets or external analytics.
