import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const allowed = new Set(['index.html', 'style.css', 'app.js', 'core.js', 'favicon.svg']);
const types = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };
createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'index.html';
  if (!allowed.has(name)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(fileURLToPath(new URL(name, root)));
    res.writeHead(200, { 'Content-Type': types[name.split('.').pop()], 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('Ясно: http://127.0.0.1:4173'));
