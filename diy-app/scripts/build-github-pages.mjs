import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "pages-dist");
const clientDirectory = resolve(projectRoot, "dist/client");
const repositoryBase = "/AeroDIY";

function pagesHtml(html) {
  return html
    .replaceAll("/assets/", `${repositoryBase}/assets/`)
    .replace(/(?<!AeroDIY)\/([\w-]+\.(?:png|svg))/g, `${repositoryBase}/$1`)
    .replaceAll("http://localhost:3000/og.png", "https://aerovfx.github.io/AeroDIY/og.png")
    .replaceAll('href="/', `href="${repositoryBase}/`)
    .replaceAll('src="/', `src="${repositoryBase}/`)
    .replaceAll('srcset="/', `srcset="${repositoryBase}/`)
    .replace("</head>", `<base href="${repositoryBase}/" /></head>`)
    .replaceAll(`${repositoryBase}${repositoryBase}/`, `${repositoryBase}/`);
}

async function renderRoute(worker, pathname) {
  const response = await worker.fetch(
    new Request(`https://aerovfx.github.io${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );

  if (!response.ok) {
    throw new Error(`Không thể render ${pathname}: HTTP ${response.status}`);
  }

  return pagesHtml(await response.text());
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(clientDirectory, outputDirectory, { recursive: true });

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("github-pages", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const homeHtml = await renderRoute(worker, "/");
await writeFile(resolve(outputDirectory, "index.html"), homeHtml);
await writeFile(resolve(outputDirectory, "404.html"), homeHtml);

const gpuLabDirectory = resolve(outputDirectory, "gpu-lab");
await mkdir(gpuLabDirectory, { recursive: true });
await writeFile(resolve(gpuLabDirectory, "index.html"), await renderRoute(worker, "/gpu-lab"));
await writeFile(resolve(outputDirectory, ".nojekyll"), "");

const indexHtml = await readFile(resolve(outputDirectory, "index.html"), "utf8");
if (!indexHtml.includes(`${repositoryBase}/assets/`) || !indexHtml.includes("AeroDIY")) {
  throw new Error("Bản GitHub Pages thiếu asset base path hoặc nội dung AeroDIY.");
}

console.log(`GitHub Pages artifact: ${outputDirectory}`);
