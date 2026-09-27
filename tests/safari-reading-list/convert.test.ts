/**
 * The Safari Reading List conversion, outside Obsidian.
 *
 * The input is the JSON that `safari --json reading-list` prints (safari-py):
 * an envelope around an array of items, or the bare array, or the charter's
 * manifest shape with `items`. Everything here is pure: no vault, no network.
 */
import '../shims/dom';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	canonicalUrl,
	parseReadingList,
	readingListFrontMatter,
	readingListTitle,
	readingListVariables,
	stubMarkdown,
} from '../../src/formats/safari-reading-list/convert';

const ENVELOPE = JSON.stringify({
	status: 'ok',
	data: [
		{
			title: 'How to identify propaganda',
			uuid: '9F2C1A44-0000-0000-0000-000000000001',
			url: 'https://example.com/article?utm_source=x&id=7',
			date_added: '2026-04-29T13:00:18.788909',
			preview_text: 'A short summary.',
		},
		{
			title: 'PROJECT\nSort Non-Sequential Project Tasks by Name',
			uuid: '9F2C1A44-0000-0000-0000-000000000002',
			url: 'https://omni-automation.com/omnifocus/actions.html',
			date_added: '2026-05-01T15:43:49.686175',
			preview_text: null,
		},
		{ title: 'Broken', uuid: 'x', url: 'not a url' },
		{ uuid: 'y' },
	],
});

test('the safari-py envelope parses into items, skipping malformed entries', () => {
	const items = parseReadingList(ENVELOPE);

	assert.equal(items.length, 2);
	assert.equal(items[0].uuid, '9F2C1A44-0000-0000-0000-000000000001');
	assert.equal(items[0].url, 'https://example.com/article?utm_source=x&id=7');
	assert.equal(items[0].previewText, 'A short summary.');
	assert.equal(items[0].dateAdded, '2026-04-29T13:00:18.788909');
	assert.equal(items[1].previewText, undefined);
});

test('a bare array and a manifest with items parse the same way', () => {
	const item = { title: 'T', uuid: 'u', url: 'https://a.example/' };

	assert.equal(parseReadingList(JSON.stringify([item])).length, 1);
	assert.equal(parseReadingList(JSON.stringify({ schema: 'reading-list-import/1', items: [item] })).length, 1);
});

test('manifest field names and the plist extras are read when present', () => {
	const [item] = parseReadingList(JSON.stringify([{
		id: 'ID-1',
		url: 'https://a.example/x',
		title: 'X',
		date_added: '2026-01-02T03:04:05',
		site_name: 'Example',
		image_url: 'https://a.example/x.png',
		date_last_viewed: '2026-01-03T00:00:00',
	}]));

	assert.equal(item.uuid, 'ID-1');
	assert.equal(item.siteName, 'Example');
	assert.equal(item.imageUrl, 'https://a.example/x.png');
	assert.equal(item.dateLastViewed, '2026-01-03T00:00:00');
});

test('text that is not JSON, or JSON without a list, is an error', () => {
	assert.throws(() => parseReadingList('not json'));
	assert.throws(() => parseReadingList('{"status":"ok"}'));
	assert.throws(() => parseReadingList('42'));
});

test('the canonical URL drops tracking parameters, fragments, and case in the host', () => {
	assert.equal(
		canonicalUrl('HTTPS://Example.COM:443/Article/?utm_source=x&id=7&fbclid=abc#top'),
		'https://example.com/Article?id=7',
	);
	assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/');
	assert.equal(canonicalUrl('https://example.com'), 'https://example.com/');
	assert.equal(canonicalUrl('not a url'), 'not a url');
});

test('the note title collapses whitespace and falls back to the domain', () => {
	const [, multiline] = parseReadingList(ENVELOPE);
	assert.equal(readingListTitle(multiline), 'PROJECT Sort Non-Sequential Project Tasks by Name');

	const [untitled] = parseReadingList(JSON.stringify([{ uuid: 'u', url: 'https://news.example.org/a/b', title: '' }]));
	assert.equal(readingListTitle(untitled), 'news.example.org');
	assert.equal(readingListTitle(untitled, 'From the page'), 'From the page');
});

test('variables carry the item, its status, and whether it was viewed', () => {
	const [item] = parseReadingList(ENVELOPE);
	const variables = readingListVariables(item, 'unresolved');

	assert.equal(variables.uuid, item.uuid);
	assert.equal(variables.url, item.url);
	assert.equal(variables.canonicalUrl, 'https://example.com/article?id=7');
	assert.equal(variables.domain, 'example.com');
	assert.equal(variables.previewText, 'A short summary.');
	assert.equal(variables.importStatus, 'unresolved');
	assert.equal(variables.read, false);

	const viewed = readingListVariables({ ...item, dateLastViewed: '2026-05-01T00:00:00' }, 'fetched');
	assert.equal(viewed.read, true);
});

test('extracted values sit under the item facts, and are kept where the item has none', () => {
	const [item] = parseReadingList(ENVELOPE);
	const variables = readingListVariables(item, 'fetched', {
		url: 'https://example.com/canonical',
		site: 'Example Site',
		author: 'A. Writer',
		words: 900,
	});

	assert.equal(variables.url, item.url);
	assert.equal(variables.siteName, 'Example Site');
	assert.equal(variables.author, 'A. Writer');
	assert.equal(variables.words, 900);
});

test('frontmatter records the source, and description and site only when known', () => {
	const [item, bare] = parseReadingList(ENVELOPE);

	assert.deepEqual(readingListFrontMatter(item, 'fetched'), {
		url: 'https://example.com/article?utm_source=x&id=7',
		description: 'A short summary.',
		added: '2026-04-29T13:00:18.788909',
		read: false,
		'import-status': 'fetched',
	});
	assert.deepEqual(readingListFrontMatter({ ...bare, siteName: 'Omni' }, 'unresolved'), {
		url: 'https://omni-automation.com/omnifocus/actions.html',
		site: 'Omni',
		added: '2026-05-01T15:43:49.686175',
		read: false,
		'import-status': 'unresolved',
	});
});

test('the stub for an unresolved item links the page and keeps the preview text', () => {
	const [item, bare] = parseReadingList(ENVELOPE);

	assert.equal(
		stubMarkdown(item, 'HTTP 404'),
		'[How to identify propaganda](https://example.com/article?utm_source=x&id=7)\n\n> A short summary.\n\nContent could not be fetched: HTTP 404\n',
	);
	assert.equal(
		stubMarkdown(bare),
		'[PROJECT Sort Non-Sequential Project Tasks by Name](https://omni-automation.com/omnifocus/actions.html)\n\nContent was not fetched.\n',
	);
});
