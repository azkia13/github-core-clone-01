// The forge's server, as main.ts builds it: the real implementation lives in src/app.ts
// (git smart HTTP, REST v3, GraphQL v4 and MCP); this file is the entrypoint's import, so it
// re-exports the factory that reads the bearer token from MAKEFUN_SHOP_TOKEN.
export { createApp, createForgeServer } from './src/app.ts';
