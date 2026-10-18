import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadMarsResources } from '../src/resources.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mars-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'context');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'entry.md'), 'Synthetic catalog fixture.');
  writeFileSync(join(dir, 'outside.txt'), 'Synthetic outside-root fixture.');
  const catalogPath = join(dir, 'resources.json');
  const entry = { uri: 'mars://context/notes/entry', name: 'Synthetic fixture', description: '',
    file: 'notes/entry.md', allowRoles: ['member'] };
  writeFileSync(catalogPath, JSON.stringify({ resources: [entry] }));
  return { dir, root, catalogPath, entry, options: { resourceCatalogPath: catalogPath, resourceRoot: root } };
}

test('default catalog contains only the packaged synthetic demonstration', () => {
  const resources = loadMarsResources();
  assert.deepEqual(resources.map(resource => resource.metadata.uri), ['mars://demo/role-gated']);
  assert.match(resources[0]!.text, /Copper Finch/);
});

test('custom catalog accepts ordinary Mars URIs and nested relative text files', t => {
  const f = fixture(t);
  const first = loadMarsResources(f.options);
  assert.deepEqual(first, [{ metadata: { uri: f.entry.uri, name: f.entry.name, description: '', mimeType: 'text/plain' },
    allowRoles: ['member'], text: 'Synthetic catalog fixture.' }]);
  writeFileSync(join(f.root, 'notes', 'entry.md'), 'Updated synthetic fixture.');
  assert.equal(first[0]!.text, 'Synthetic catalog fixture.');
  assert.equal(loadMarsResources(f.options)[0]!.text, 'Updated synthetic fixture.');
  assert.equal(loadMarsResources()[0]!.metadata.uri, 'mars://demo/role-gated');
});

test('configuration must supply both paths and never falls back on invalid custom configuration', t => {
  const f = fixture(t);
  assert.throws(() => loadMarsResources({ resourceCatalogPath: f.catalogPath }), /together/);
  assert.throws(() => loadMarsResources({ resourceRoot: f.root }), /together/);
  assert.throws(() => loadMarsResources({ ...f.options, resourceCatalogPath: join(f.dir, 'missing.json') }));
  assert.throws(() => loadMarsResources({ ...f.options, resourceRoot: join(f.dir, 'outside.txt') }), /directory/);
  writeFileSync(f.catalogPath, 'not JSON');
  assert.throws(() => loadMarsResources(f.options));
});

test('relative entries reject traversal, absolute paths, and ambiguous separators', t => {
  const f = fixture(t);
  for (const file of ['../outside.txt', 'notes/../../outside.txt', join(f.dir, 'outside.txt'),
    'C:/private/file.txt', 'C:\\private\\file.txt', '\\\\server\\share\\file.txt',
    'notes/../notes/entry.md', './notes/entry.md', 'notes\\entry.md', 'notes//entry.md', 'notes/entry.md\0']) {
    writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, file }] }));
    assert.throws(() => loadMarsResources(f.options), `must reject ${JSON.stringify(file)}`);
  }
});

test('symlink files and directories cannot escape the configured root', t => {
  const f = fixture(t);
  // A similarly prefixed sibling must not pass a naive string-prefix check.
  const sibling = `${f.root}-outside`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'entry.md'), 'Synthetic sibling fixture.');
  symlinkSync(join(f.dir, 'outside.txt'), join(f.root, 'outside-link.txt'));
  symlinkSync(sibling, join(f.root, 'outside-directory'));
  for (const file of ['outside-link.txt', 'outside-directory/entry.md']) {
    writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, file }] }));
    assert.throws(() => loadMarsResources(f.options), /escapes the configured root/);
  }
  // Symlinks that stay inside the root do not broaden authority.
  symlinkSync(join(f.root, 'notes', 'entry.md'), join(f.root, 'inside-link.txt'));
  writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, file: 'inside-link.txt' }] }));
  assert.equal(loadMarsResources(f.options)[0]!.text, 'Synthetic catalog fixture.');
});

test('catalog rejects duplicate URIs and requires explicit role policy', t => {
  const f = fixture(t);
  writeFileSync(f.catalogPath, JSON.stringify({ resources: [f.entry, { ...f.entry, allowRoles: [] }] }));
  assert.throws(() => loadMarsResources(f.options), /Duplicate resource URI/);
  const { allowRoles, ...withoutRoles } = f.entry;
  writeFileSync(f.catalogPath, JSON.stringify({ resources: [withoutRoles] }));
  assert.throws(() => loadMarsResources(f.options));
  writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, allowRoles: [] }] }));
  assert.deepEqual(loadMarsResources(f.options)[0]!.allowRoles, []);
  for (const uri of ['file:///etc/passwd', 'https://example.invalid/document', 'mars://user:password@context/notes',
    'mars://context/notes?path=outside', 'mars://context/notes#fragment']) {
    writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, uri }] }));
    assert.throws(() => loadMarsResources(f.options));
  }
});

test('resource size is bounded in bytes and only regular files are loaded', t => {
  const f = fixture(t);
  const path = join(f.root, 'notes', 'entry.md');
  writeFileSync(path, Buffer.alloc(65536, 97));
  assert.equal(Buffer.byteLength(loadMarsResources(f.options)[0]!.text), 65536);
  writeFileSync(path, Buffer.alloc(65537, 97));
  assert.throws(() => loadMarsResources(f.options), /exceeds 64 KiB/);
  writeFileSync(path, 'é'.repeat(32769));
  assert.throws(() => loadMarsResources(f.options), /exceeds 64 KiB/);
  writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, file: 'notes' }] }));
  assert.throws(() => loadMarsResources(f.options), /regular file/);
  writeFileSync(f.catalogPath, JSON.stringify({ resources: [{ ...f.entry, file: 'missing.txt' }] }));
  assert.throws(() => loadMarsResources(f.options));
});
