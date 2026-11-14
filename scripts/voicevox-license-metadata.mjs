import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
const data = readFileSync(process.argv[2]);
const metadata = JSON.parse(data.toString(data[0] === 0xff && data[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
const root = metadata.packages.find(p => p.name === 'voicevox_core_c_api');
const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of nodes.get(id)?.deps ?? [])
    if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
}
visit(root.id);
const lock = readFileSync(join(dirname(process.argv[2]), 'voicevox_core-0.17.1/Cargo.lock'), 'utf8');
const checksums = new Map(lock.split('[[package]]').slice(1).map(section => [
  `${section.match(/^name = "([^"]+)"/m)?.[1]}@${section.match(/^version = "([^"]+)"/m)?.[1]}`,
  section.match(/^checksum = "([^"]+)"/m)?.[1]
]));
function checksum(p) {
  if (!p.source?.startsWith('registry+')) return null;
  const expected = checksums.get(`${p.name}@${p.version}`);
  const archive = p.manifest_path.replace(/([\\/]registry[\\/])src([\\/])/, '$1cache$2').replace(/[\\/]Cargo\.toml$/, '.crate');
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (actual !== expected) throw new Error(`Locked crate checksum mismatch: ${p.name}`);
  return actual;
}
writeFileSync(process.argv[3], JSON.stringify({packages: metadata.packages.filter(p => included.has(p.id)).map(p => ({
  name: p.name, version: p.version, license: p.license, license_file: p.license_file,
  manifest_path: p.manifest_path, source: p.source, repository: p.repository,
  checksum: checksum(p)
}))}));
