// workerd cấp `cloudflare:workers` như một built-in module thật khi deploy; node --test
// chạy thẳng dist/server/index.js đã build (xem tests/rendered-html.test.mjs) nên cần
// shim scheme này lại — nếu không, ESM loader của Node báo ERR_UNSUPPORTED_ESM_URL_SCHEME
// ngay khi import bundle, dù test không gọi tới route nào đụng D1.
const SHIM_URL = "cloudflare-workers-shim:env";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: SHIM_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === SHIM_URL) return { format: "module", shortCircuit: true, source: "export const env = {};" };
  return nextLoad(url, context);
}
