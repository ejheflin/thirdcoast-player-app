// archive/_serve-repo-root.js — dev-time only. Serves docs/ at / , which is
// exactly what GitHub Pages does when its source is set to "/docs on the
// default branch": docs/ is self-contained (pages + data), and archive/
// (including archive/fixtures/, which holds real captured LeagueApps pages)
// stays outside it and is never web-reachable.
//
// Run from the repo root with: node archive/_serve-repo-root.js
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = normalize(join(DOCS_ROOT, rel));
  if (!full.startsWith(DOCS_ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    await stat(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(await readFile(full));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(8124, () => console.log('serving docs/ on http://localhost:8124/ (same layout GitHub Pages serves)'));
