import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputDir } from '../src/lib/output-dir.ts';

const base = {
  outputMode: 'folder' as const,
  isDesktop: true,
  outputDir: '/chosen/out',
  defaultDir: '/Documents/PoTools',
  filePaths: [],
};

test('folder mode uses the configured output dir', () => {
  assert.equal(resolveOutputDir(base), '/chosen/out');
});

test('folder mode falls back to the engine default when unset', () => {
  assert.equal(resolveOutputDir({ ...base, outputDir: null }), '/Documents/PoTools');
});

test('folder mode returns null when nothing is configured', () => {
  assert.equal(resolveOutputDir({ ...base, outputDir: null, defaultDir: null }), null);
});

test('source mode on desktop resolves the common parent of the job files', () => {
  assert.equal(
    resolveOutputDir({
      ...base,
      outputMode: 'source',
      filePaths: ['/Users/me/docs/a.pdf', '/Users/me/docs/b.pdf'],
    }),
    '/Users/me/docs',
  );
});

test('source mode is desktop only — browser keeps the folder flow', () => {
  assert.equal(
    resolveOutputDir({
      ...base,
      outputMode: 'source',
      isDesktop: false,
      filePaths: ['/Users/me/docs/a.pdf'],
    }),
    '/chosen/out',
  );
});

test('source mode falls back to the folder when files share no common parent', () => {
  assert.equal(
    resolveOutputDir({
      ...base,
      outputMode: 'source',
      filePaths: ['/a/f.pdf', '/b/f.pdf'],
    }),
    '/chosen/out',
  );
});

test('source mode falls back when the job has no desktop paths', () => {
  assert.equal(
    resolveOutputDir({
      ...base,
      outputMode: 'source',
      filePaths: [null, undefined],
    }),
    '/chosen/out',
  );
});

test('a resolved source dir wins over the configured folder', () => {
  assert.equal(
    resolveOutputDir({
      outputMode: 'source',
      isDesktop: true,
      outputDir: '/chosen/out',
      defaultDir: null,
      filePaths: ['/tmp/potools-uitest/sample.pdf'],
    }),
    '/tmp/potools-uitest',
  );
});

test('browser mode with nothing configured resolves to null (download flow)', () => {
  assert.equal(
    resolveOutputDir({
      outputMode: 'folder',
      isDesktop: false,
      outputDir: null,
      defaultDir: null,
      filePaths: [],
    }),
    null,
  );
});
