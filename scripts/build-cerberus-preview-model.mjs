import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const publicDir = path.join(process.cwd(), 'public', 'cerberus3d');
const partFiles = ['p0.js', 'p1.js', 'p2.js'];

const chunks = partFiles.map((fileName) => {
  const source = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
  const match = source.match(/\+'([^']+)'\s*;?\s*$/s);
  if (!match) {
    throw new Error(`Could not extract Cerberus payload from ${fileName}`);
  }
  return match[1];
});

const compressed = Buffer.from(chunks.join(''), 'base64');
const glb = zlib.gunzipSync(compressed);

if (glb.subarray(0, 4).toString('ascii') !== 'glTF') {
  throw new Error('Generated Cerberus model is not a valid GLB payload');
}

const outputPath = path.join(publicDir, 'cerberus-refined.glb');
fs.writeFileSync(outputPath, glb);
console.log(`[cerberus-3d] generated ${outputPath} (${glb.length} bytes)`);
