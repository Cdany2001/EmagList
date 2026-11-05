/* Splits products.json into data/index.json plus data/cN.json chunks.
   Nothing but the index is needed to start the app; a chunk is fetched when the virtual scroller
   reaches the rows it holds. Run with: node tools/split-data.js */
const fs = require('fs'), path = require('path');

const CHUNK = 250;
const root = path.join(__dirname, '..');
const out = path.join(root, 'data');

const D = JSON.parse(fs.readFileSync(path.join(root, 'products.json'), 'utf8'));
const ids = D.items.map(r => r[0]);
const firstId = ids[0];
const sequential = ids.every((id, i) => id === firstId + i);

fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/^c\d+\.json$/.test(f)) fs.unlinkSync(path.join(out, f));

const chunks = Math.ceil(D.items.length / CHUNK);
let bytes = 0;
for (let k = 0; k < chunks; k++) {
  const body = JSON.stringify(D.items.slice(k * CHUNK, (k + 1) * CHUNK));
  fs.writeFileSync(path.join(out, 'c' + k + '.json'), body);
  bytes += Buffer.byteLength(body);
}
// Counting the tags here means the filter sidebar can show real numbers for all 34,083 products
// without the browser having downloaded any of them.
const counts = new Array(D.tags.length).fill(0);
for (const r of D.items) for (const i of new Set(r[4])) counts[i]++;
// A stamp over the data itself: the browser keeps the chunks it has fetched, and this is what
// tells it to throw them away when the list is split again.
const v = require('crypto').createHash('sha1').update(JSON.stringify(D.items)).digest('hex').slice(0, 10);
const index = { v, count: D.items.length, chunk: CHUNK, chunks, firstId, sequential, tags: D.tags, counts, brands: D.brands };
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));

const ix = fs.statSync(path.join(out, 'index.json')).size;
console.log(`${D.items.length} products -> ${chunks} chunks of ${CHUNK}`);
// Chunk sizes vary a lot with the length of the names in them, so the first screen is quoted from
// the chunk it actually fetches rather than from the average.
const c0 = fs.statSync(path.join(out, 'c0.json')).size;
console.log(`index.json ${(ix / 1024).toFixed(1)} KB, chunks ${(bytes / 1048576).toFixed(2)} MB total, ${(bytes / chunks / 1024).toFixed(1)} KB on average`);
console.log(`first screen costs index + c0.json = ${((ix + c0) / 1024).toFixed(1)} KB uncompressed, was ${(fs.statSync(path.join(root, 'products.json')).size / 1048576).toFixed(2)} MB`);
console.log(`ids sequential from ${firstId}: ${sequential}`);
