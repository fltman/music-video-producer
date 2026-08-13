#!/usr/bin/env node
// Minimal statisk server med Range-stöd (videoelement kräver det för assets/).
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8162);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) return end(res, 403, 'Förbjuden sökväg');
  let st;
  try {
    st = statSync(path);
    if (st.isDirectory()) {
      path = join(path, 'index.html');
      st = statSync(path);
    }
  } catch {
    return end(res, 404, 'Hittades inte');
  }

  const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const endByte = m && m[2] ? Number(m[2]) : st.size - 1;
    if (start >= st.size) return end(res, 416, 'Utanför intervall');
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${endByte}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': endByte - start + 1,
      'Cache-Control': 'no-cache',
    });
    return createReadStream(path, { start, end: endByte }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  createReadStream(path).pipe(res);
}).listen(PORT, () => {
  console.log(`Musikvideoproducenten → http://localhost:${PORT}`);
});

function end(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}
