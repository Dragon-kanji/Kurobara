// Hatchet starts its heartbeat in a worker thread resolved next to the
// application entrypoint. The standalone runtime therefore ships this
// dependency-owned entrypoint as a dedicated CommonJS bundle.
import "@hatchet-dev/typescript-sdk/clients/dispatcher/heartbeat/heartbeat-worker.js";
