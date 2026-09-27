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
	linkMarkdown,
	noteKindFor,
	parseReadingList,
	readingListFrontMatter,
	readingListTitle,
	readingListVariables,
	templateSafe,
	uuidv7,
	whyThisLink,
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

test('the canonical URL drops tracking parameters but keeps the ones that select content', () => {
	assert.equal(canonicalUrl('https://example.com/a?utm_source=x&fbclid=abc&gclid=d'), 'https://example.com/a');
	assert.equal(canonicalUrl('https://example.com/a?id=7&utm_campaign=y'), 'https://example.com/a?id=7');
	assert.equal(canonicalUrl('https://example.com/a?page=2&q=safari'), 'https://example.com/a?page=2&q=safari');
});

test('the canonical URL drops a fragment that points within the page, and keeps one that selects it', () => {
	assert.equal(canonicalUrl('https://example.com/a#section-3'), 'https://example.com/a');
	assert.equal(canonicalUrl('https://groups.example.com/g/x#!topic/a'), 'https://groups.example.com/g/x#!topic/a');
	assert.equal(canonicalUrl('https://app.example.com/#/inbox'), 'https://app.example.com/#/inbox');
});

test('the canonical URL normalizes the default port, the trailing slash and the host', () => {
	assert.equal(canonicalUrl('HTTPS://Example.COM:443/Article/'), 'https://example.com/Article');
	assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/');
	assert.equal(canonicalUrl('https://example.com'), 'https://example.com/');
	// A path's case can matter, so it is left alone.
	assert.notEqual(canonicalUrl('https://example.com/Article'), canonicalUrl('https://example.com/article'));
});

test('the canonical URL carries no credentials, so none reach a note', () => {
	assert.equal(canonicalUrl('https://user:secret@example.com/a'), 'https://example.com/a');
});

test('a value that is not a web URL is returned as it came', () => {
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

const IDENTITY = {
	title: 'How to identify propaganda',
	uid: '01a0e000-0000-7000-8000-000000000001',
	now: new Date(2026, 8, 27, 9, 30, 0),
};

test('a clipping carries the identity every note has, plus the fields its own class declares', () => {
	const [item] = parseReadingList(ENVELOPE);

	assert.deepEqual(readingListFrontMatter(item, 'fetched', { site: 'Example', author: 'A. Writer' }, 'clipping', IDENTITY), {
		title: 'How to identify propaganda',
		description: 'A short summary.',
		type: 'Note/Clipping/Web',
		uid: '01a0e000-0000-7000-8000-000000000001',
		created: '2026-04-29T13:00:18.788909',
		modified: '2026-09-27T09:30:00',
		status: 'captured',
		tags: [],
		url: 'https://example.com/article?utm_source=x&id=7',
		source: 'Example',
		author: ['A. Writer'],
		clipped: '2026-09-27T09:30:00',
	});
});

test('a link carries its own class fields instead, and holds no material', () => {
	const [item] = parseReadingList(ENVELOPE);

	assert.deepEqual(readingListFrontMatter({ ...item, dateLastViewed: '2026-05-01T00:00:00' }, 'fetched', {}, 'link', IDENTITY), {
		title: 'How to identify propaganda',
		description: 'A short summary.',
		type: 'Note/Link',
		uid: '01a0e000-0000-7000-8000-000000000001',
		created: '2026-04-29T13:00:18.788909',
		modified: '2026-09-27T09:30:00',
		status: 'captured',
		tags: [],
		url: 'https://example.com/article?utm_source=x&id=7',
		rating: '',
		read: true,
		clipping: '',
	});
});

test('a page that did not arrive is a link even when a clipping was asked for', () => {
	const [item] = parseReadingList(ENVELOPE);

	assert.equal(noteKindFor('clipping', 'unresolved'), 'link');
	assert.equal(noteKindFor('clipping', 'fetched'), 'clipping');
	assert.equal(noteKindFor('link', 'fetched'), 'link');
	assert.equal(readingListFrontMatter(item, 'unresolved', {}, 'clipping', IDENTITY).type, 'Note/Link');
});

test('a minted identity is a UUIDv7, so identities sort by when they were made', () => {
	const earlier = uuidv7(new Date(2026, 0, 1).getTime());
	const later = uuidv7(new Date(2026, 6, 1).getTime());

	assert.match(earlier, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
	assert.ok(earlier < later, `${earlier} should sort before ${later}`);
});

test('the whole raw page never reaches a template, and neither does any absurd value', () => {
	const safe = templateSafe({
		title: 'A title',
		site: 'Example',
		words: 900,
		fullHtml: '<html>the whole page</html>',
		contentHtml: 'x'.repeat(1_000_001),
		description: 'y'.repeat(1_000_000),
	});

	assert.deepEqual(Object.keys(safe).sort(), ['description', 'site', 'title', 'words']);
	assert.equal(safe.words, 900);
});

test('why a link is here keeps the preview text and says when the page did not arrive', () => {
	const [item, bare] = parseReadingList(ENVELOPE);

	assert.equal(
		whyThisLink(item, 'HTTP 404'),
		'A short summary.\n\nSaved from the Safari reading list. The page could not be fetched when this note was made: HTTP 404.',
	);
	assert.equal(whyThisLink(bare), 'Saved from the Safari reading list.');
});

test('a link note is written in the shape the vault gives its own link notes', () => {
	const [item] = parseReadingList(ENVELOPE);
	const body = linkMarkdown(item, 'Because it matters.');

	assert.match(body, /\n## Why it matters\n\nBecause it matters\.\n/u);
	assert.match(body, /\n### Status key\n/u);
	assert.match(body, /\n`BUTTON\[convert-to-clipping\]`\n/u);
	assert.match(body, /executeChoice\("Convert link to clipping…", \{\}\)/u);
});
