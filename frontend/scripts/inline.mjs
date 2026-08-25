import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function resolveAsset(htmlPath, href) {
  const clean = href.replace(/^\.?\//, '');
  return resolve(dirname(htmlPath), clean);
}

function inlineFile(htmlPath, outPath) {
  let html = readFileSync(htmlPath, 'utf8');
  let inlined = 0;
  const styles = [];
  const scripts = [];

  // Extract / inline stylesheets
  html = html.replace(
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g,
    (_, href) => {
      const cssPath = resolveAsset(htmlPath, href);
      if (!existsSync(cssPath)) return '';
      const css = readFileSync(cssPath, 'utf8');
      inlined += 1;
      styles.push(css);
      return '';
    },
  );

  // Extract / inline external scripts
  html = html.replace(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/g,
    (_, src) => {
      const jsPath = resolveAsset(htmlPath, src);
      if (!existsSync(jsPath)) return '';
      const js = readFileSync(jsPath, 'utf8');
      inlined += 1;
      scripts.push(js);
      return '';
    },
  );

  // Extract / inline module scripts
  html = html.replace(
    /<script\b[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/g,
    (_, code) => {
      if (!code || code.trim().length === 0) return '';
      inlined += 1;
      scripts.push(code);
      return '';
    },
  );

  // Insert styles into <head>
  if (styles.length > 0) {
    const styleTag = `<style>\n${styles.join('\n')}\n</style>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${styleTag}\n</head>`);
    } else {
      html = styleTag + html;
    }
  }

  // Insert scripts after #root or before </body>
  if (scripts.length > 0) {
    const scriptTag = `<script>\n${scripts.join('\n')}\n</script>`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${scriptTag}\n</body>`);
    } else {
      html = html + scriptTag;
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return inlined;
}

let failed = false;

const jobs = [
  { in: resolve(root, 'dist-panel', 'panel.html'), out: resolve(root, 'dist', 'panel.html') },
  { in: resolve(root, 'dist-viewer', 'viewer.html'), out: resolve(root, 'dist', 'viewer.html') },
];

for (const job of jobs) {
  if (!existsSync(job.in)) {
    console.error('inline.mjs: missing ' + job.in);
    failed = true;
    continue;
  }
  const n = inlineFile(job.in, job.out);
  console.log('inline.mjs: ' + job.out + ' inlined ' + n + ' asset(s)');
}

for (const dir of ['dist-panel', 'dist-viewer']) {
  const p = resolve(root, dir);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log('inline.mjs: removed ' + dir + '/');
  }
}

if (failed) process.exit(1);
