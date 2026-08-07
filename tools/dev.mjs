// dev.mjs — the repo, served for local work.
//
// The shipped security policy names only real addresses. Local work needs one
// more: the pretended club on port 5179. This server injects that origin into
// the policy as index.html passes through, and changes nothing else. Run the
// mock beside it and the whole membership can be walked without an account.
//
//   node tools/dev.mjs          (port 5178)
//   node club/mock.mjs          (port 5179)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 5178;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain',
  '.md': 'text/plain; charset=utf-8',
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

    let body = await readFile(file);
    if (path === 'index.html') {
      body = Buffer.from(body.toString().replace(
        /connect-src ([^;]+);/,
        'connect-src $1 http://localhost:5179;',
      ));
    }
    // ranges, so the intro film can seek locally too
    const range = req.headers.range;
    const type = TYPES[extname(path)] || 'application/octet-stream';
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : body.length - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nothing lives here');
  }
}).listen(PORT, () => console.log(`resonate, locally, at http://localhost:${PORT}`));
