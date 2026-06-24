// Polyfill fetch for Node.js 14
// OpenAI SDK v6+ and our direct fetch calls require global fetch
import nodeFetch from "node-fetch";

if (!(globalThis as any).fetch) {
  (globalThis as any).fetch = nodeFetch as any;
  (globalThis as any).Headers = (nodeFetch as any).Headers;
  (globalThis as any).Request = (nodeFetch as any).Request;
  (globalThis as any).Response = (nodeFetch as any).Response;
}
