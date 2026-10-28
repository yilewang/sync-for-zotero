import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(new URL('../extension/gemini_artifact_frame.js', import.meta.url), 'utf8');

test('artifact capture replays only provider-delivered source from the parent', () => {
  let receive;
  const replies = [];
  const parent = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const window = { parent, location: { href: 'about:srcdoc' }, addEventListener: (_, fn) => { receive = fn; } };
  vm.runInNewContext(source, { window });
  const send = (data, sender = parent, origin = 'https://gemini.google.com') => receive({ data, source: sender, origin });
  send({ type: 'genui-morph', html: '<svg>wrong</svg>' }, {});
  send({ type: 'genui-morph', html: '<svg>wrong</svg>' }, parent, 'https://example.com');
  assert.equal(replies.length, 0);
  send({ type: 'genui-morph', html: '<svg><circle/></svg>' });
  send({ type: 'SYNC_ZOTERO_GEMINI_ARTIFACT_REQUEST' });
  assert.equal(replies.length, 2);
  assert.equal(replies[1].message.html, '<svg><circle/></svg>');
  assert.equal(replies[1].origin, 'https://gemini.google.com');
});

test('artifact bootstrap is restricted to Gemini-related frames at document start', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const entry = manifest.content_scripts.find(entry => entry.js.includes('gemini_artifact_frame.js'));
  assert.deepEqual(entry.matches, ['https://gemini.google.com/*']);
  assert.equal(entry.all_frames, true);
  assert.equal(entry.match_origin_as_fallback, true);
  assert.equal(entry.run_at, 'document_start');
});
