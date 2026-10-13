import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonParentDir } from '../src/lib/paths.ts';

test('single POSIX file resolves to its directory', () => {
  assert.equal(commonParentDir(['/Users/me/docs/a.pdf']), '/Users/me/docs');
});

test('files in the same directory resolve to that directory', () => {
  assert.equal(
    commonParentDir(['/Users/me/docs/a.pdf', '/Users/me/docs/b.pdf', '/Users/me/docs/c.png']),
    '/Users/me/docs',
  );
});

test('nested paths share the deepest common folder', () => {
  assert.equal(
    commonParentDir(['/work/out/a.pdf', '/work/out/sub/b.pdf']),
    '/work/out',
  );
});

test('siblings sharing only a grandparent resolve to the grandparent', () => {
  assert.equal(
    commonParentDir(['/work/inbox/a.pdf', '/work/archive/b.pdf']),
    '/work',
  );
});

test('paths sharing only the POSIX root return null', () => {
  assert.equal(commonParentDir(['/a/file.pdf', '/b/file.pdf']), null);
});

test('empty input returns null', () => {
  assert.equal(commonParentDir([]), null);
});

test('paths without a directory return null', () => {
  assert.equal(commonParentDir(['a.pdf']), null);
});

test('windows paths join with backslashes', () => {
  assert.equal(
    commonParentDir(['C:\\Users\\me\\docs\\a.pdf', 'C:\\Users\\me\\docs\\b.pdf']),
    'C:\\Users\\me\\docs',
  );
});

test('windows paths on different drives return null', () => {
  assert.equal(commonParentDir(['C:\\a\\f.pdf', 'D:\\a\\f.pdf']), null);
});

test('a bare drive root is not a usable destination', () => {
  assert.equal(commonParentDir(['C:\\a.pdf', 'C:\\b.pdf']), null);
});

test('the first path decides the separator for a common prefix', () => {
  assert.equal(
    commonParentDir(['/Users/me/docs/a.pdf', '/Users/me/docs/sub/b.pdf']),
    '/Users/me/docs',
  );
});
