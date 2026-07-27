import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const JSON_LD_PATTERN =
  /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u;
const LAST_MODIFIED_PATTERN = /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/u;

const readWebsiteFile = (relativePath) =>
  readFile(path.join(websiteRoot, relativePath), "utf8");

test("publishes one consistent canonical URL and factual structured data", async () => {
  const html = await readWebsiteFile("index.html");
  const canonicalElement =
    '<link rel="canonical" href="https://kurobara.systems/">';
  assert.equal(html.split(canonicalElement).length - 1, 1);
  assert.ok(
    html.includes(
      'content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"'
    )
  );
  assert.equal(html.includes("contract-system.md"), false);

  const jsonLdMatch = html.match(JSON_LD_PATTERN);
  assert.ok(jsonLdMatch);
  const graph = JSON.parse(jsonLdMatch[1]);
  assert.equal(graph["@context"], "https://schema.org");
  assert.deepEqual(
    graph["@graph"].map((entry) => entry["@type"]),
    ["Organization", "WebSite", "SoftwareApplication"]
  );

  const application = graph["@graph"][2];
  assert.equal(application.url, "https://kurobara.systems/");
  assert.equal(application.offers.price, 0);
  assert.equal(
    application.codeRepository,
    "https://github.com/Dragon-kanji/Kurobara"
  );
});

test("keeps robots and sitemap aligned with the canonical homepage", async () => {
  const [robots, sitemap] = await Promise.all([
    readWebsiteFile("public/robots.txt"),
    readWebsiteFile("public/sitemap.xml"),
  ]);

  assert.ok(robots.startsWith("User-agent: *\nAllow: /\n"));
  assert.ok(robots.includes("Sitemap: https://kurobara.systems/sitemap.xml"));
  assert.equal(
    sitemap.split("<loc>https://kurobara.systems/</loc>").length - 1,
    1
  );
  assert.match(sitemap, LAST_MODIFIED_PATTERN);
});

test("rejects crawl traps and redirects duplicate entry points", async () => {
  const nginx = await readWebsiteFile("nginx.conf");

  assert.ok(
    nginx.includes(
      "location = /index.html {\n    return 308 https://kurobara.systems/;\n  }"
    )
  );
  assert.ok(nginx.includes("location / {\n    try_files $uri =404;\n  }"));
  assert.equal(nginx.includes("try_files $uri $uri/ /index.html"), false);
  assert.ok(nginx.includes("server_name www.kurobara.systems;"));
  assert.ok(nginx.includes("return 308 https://kurobara.systems$request_uri;"));
  assert.ok(
    nginx.includes('add_header X-Robots-Tag "noindex, nofollow" always;')
  );
});
