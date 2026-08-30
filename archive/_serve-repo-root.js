// archive/_serve-repo-root.js — serves the whole repo root so relative
// site/ and data/ paths resolve exactly as they will on GitHub Pages.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname === '/' ? '/site/index.html' : `/site${url.pathname}`;
  if (url.pathname.startsWith('/data/')) p = url.pathname;
  const full = join(ROOT, p);
  try {
    await stat(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(await readFile(full));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(8124, () => console.log('serving repo root on :8124 (site/ at /, data/ at /data/)'));
