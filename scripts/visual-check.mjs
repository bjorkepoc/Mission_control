import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const publicOrigin = readEnvValue(path.join(repoRoot, "frontend", ".env"), "NEXT_PUBLIC_API_URL").replace(/\/+$/, "");
const defaultUrl = publicOrigin ? `${publicOrigin}/polymarket` : "http://127.0.0.1:3000/polymarket";
const url = process.argv[2] || defaultUrl;
const outDir = process.argv[3] ?? path.join(repoRoot, "tmp", "visual-checks");
const localAuthToken = process.env.LOCAL_AUTH_TOKEN ?? readEnvValue(path.join(repoRoot, ".env"), "LOCAL_AUTH_TOKEN");
const visualTheme = process.env.VISUAL_CHECK_THEME ?? "";
const { chromium } = await loadPlaywright();

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const localPackage = path.join(repoRoot, "frontend", "node_modules", "playwright", "index.mjs");
    return import(pathToFileURL(localPackage).href);
  }
}

function readEnvValue(filePath, key) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      if (rawKey.trim() !== key) continue;
      return rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    return "";
  }
  return "";
}

async function capture(page, viewport, filename) {
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.screenshot({
    path: path.join(outDir, filename),
    fullPage: true,
  });
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
});

try {
  const context = await browser.newContext();
  if (localAuthToken) {
    await context.addInitScript((token) => {
      window.sessionStorage.setItem("mc_local_auth_token", token);
    }, localAuthToken);
  }
  if (visualTheme) {
    await context.addInitScript((theme) => {
      window.localStorage.setItem("mc-theme", theme);
      document.documentElement?.setAttribute("data-theme", theme);
    }, visualTheme);
  }

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`[browser:error] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    console.log(`[browser:pageerror] ${error.message}`);
  });

  if (localAuthToken) {
    const originUrl = new URL("/", url).toString();
    await page.goto(originUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate((token) => {
      window.sessionStorage.setItem("mc_local_auth_token", token);
    }, localAuthToken);
    if (visualTheme) {
      await page.evaluate((theme) => {
        window.localStorage.setItem("mc-theme", theme);
        document.documentElement.setAttribute("data-theme", theme);
      }, visualTheme);
    }
  }

  await capture(page, { width: 1440, height: 1100 }, "polymarket-desktop.png");
  await capture(page, { width: 390, height: 844 }, "polymarket-mobile.png");

  const title = await page.title();
  console.log(JSON.stringify({ ok: true, url, outDir, title }, null, 2));
} finally {
  await browser.close();
}
