/**
 * The Safari Reading List importer against an in-memory vault, with every
 * page fetch answered by the test rather than the network.
 */
import '../shims/dom';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerRequests } from '../shims/obsidian';
import { DuplicateHandling } from '../../src/format-importer';
import { SafariReadingListImporter } from '../../src/formats/safari-reading-list';
import { ImportContext } from '../../src/import-context';
import { SourceFile } from '../shims/picked';
import { indexedApp, MemoryVault } from '../shims/vault';

function importer(): { vault: MemoryVault, subject: SafariReadingListImporter } {
	const vault = new MemoryVault();
	const subject = new SafariReadingListImporter(indexedApp(vault) as never, {
		sourceEl: null, outputEl: null, optionsEl: null,
	} as never);

	return { vault, subject };
}

async function importing(subject: SafariReadingListImporter, files: SourceFile[]): Promise<ImportContext> {
	await subject.ready;
	subject.files = files;
	subject.outputLocation = 'Reading List';

	const ctx = new ImportContext();
	subject.indexImportedNotes();
	await subject.import(ctx);
	await subject.finalizeMarkdownOutput(ctx);

	return ctx;
}

function page(html: string, status = 200, contentType = 'text/html; charset=utf-8') {
	return { status, headers: { 'content-type': contentType }, arrayBuffer: new TextEncoder().encode(html).buffer };
}

function readingList(items: object[]): SourceFile {
	return new SourceFile('reading-list.json', JSON.stringify({ status: 'ok', data: items }));
}

function note(vault: MemoryVault, path: string): string {
	const content = vault.contents.get(path);
	assert.equal(typeof content, 'string', `no note at ${path}; vault holds ${vault.paths().join(', ')}`);
	return content as string;
}

const ARTICLE = {
	title: 'An article',
	uuid: 'A-1',
	url: 'https://example.com/article?utm_source=x',
	date_added: '2026-04-29T13:00:18',
	preview_text: 'Preview.',
};

const ARTICLE_HTML = '<html><head><title>An article</title></head><body><main><h1>An article</h1>'
	+ '<p>The body text of the article, long enough to count as content.</p></main></body></html>';

test('a fetched page becomes a note with its extracted content and provenance', async () => {
	const { vault, subject } = importer();
	const asked: string[] = [];
	answerRequests(request => {
		asked.push(request.url);
		return page(ARTICLE_HTML);
	});

	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.deepEqual(asked, ['https://example.com/article?utm_source=x']);
	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	const content = note(vault, 'Reading List/An article.md');
	assert.match(content, /^---\n/u);
	assert.match(content, /\nsource-url: https:\/\/example\.com\/article\n/u);
	assert.match(content, /\nurl: https:\/\/example\.com\/article\?utm_source=x\n/u);
	assert.match(content, /\nimport-status: fetched\n/u);
	assert.match(content, /\ndescription: Preview\.\n/u);
	assert.match(content, /\nread: false\n/u);
	assert.match(content, /The body text of the article/u);
	assert.equal(ctx.notes, 1);
	assert.deepEqual(ctx.failed, []);
});

test('a page that cannot be fetched still becomes a stub note, not a failure', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page('gone', 404));

	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	const content = note(vault, 'Reading List/An article.md');
	assert.match(content, /\nimport-status: unresolved\n/u);
	assert.match(content, /\[An article\]\(https:\/\/example\.com\/article\?utm_source=x\)/u);
	assert.match(content, /Content could not be fetched: HTTP 404/u);
	assert.equal(ctx.notes, 1);
	assert.deepEqual(ctx.failed, []);
});

test('a response that is not HTML is a stub too', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page('%PDF-1.4', 200, 'application/pdf'));

	await importing(subject, [readingList([ARTICLE])]);

	const content = note(vault, 'Reading List/An article.md');
	assert.match(content, /\nimport-status: unresolved\n/u);
	assert.match(content, /not HTML \(application\/pdf\)/u);
});

test('with content fetching off, nothing is requested and every note is a stub', async () => {
	const { vault, subject } = importer();
	answerRequests(() => {
		throw new Error('must not fetch');
	});
	subject.fetchContent = false;

	const ctx = await importing(subject, [readingList([ARTICLE])]);

	const content = note(vault, 'Reading List/An article.md');
	assert.match(content, /\nimport-status: unresolved\n/u);
	assert.match(content, /Content was not fetched\./u);
	assert.deepEqual(ctx.failed, []);
});

test('a second run matches the note by source URL and does not create a duplicate', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));
	await importing(subject, [readingList([ARTICLE])]);

	// The same page saved again has a fresh UUID, other tracking parameters and
	// a new title, but the same canonical URL, so it is the same note.
	const again = { ...ARTICLE, uuid: 'A-2', url: 'https://example.com/article?utm_campaign=y', title: 'An article, retitled' };
	answerRequests(() => page(ARTICLE_HTML.replace(/An article/gu, 'An article, retitled')));
	const ctx = await importing(subject, [readingList([again])]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	assert.equal(ctx.notes + ctx.skipped.length, 1);
	assert.deepEqual(ctx.failed, []);
});

test('an unchanged page on a second run is left alone', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));
	await importing(subject, [readingList([ARTICLE])]);
	const before = note(vault, 'Reading List/An article.md');

	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.equal(note(vault, 'Reading List/An article.md'), before);
	assert.equal(ctx.notes, 0);
	assert.equal(ctx.skipped.length, 1);
});

test('two entries for one page in the same file import once', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));

	await importing(subject, [readingList([
		ARTICLE,
		{ ...ARTICLE, uuid: 'A-3', url: 'https://example.com/article#section' },
	])]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
});

test('a file that is not a reading list fails on its own, and an export with no web URLs is skipped', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));

	const ctx = await importing(subject, [
		readingList([{ title: 'Nope', uuid: 'N', url: 'ftp://example.com/x' }]),
		new SourceFile('other.json', '{"hello": "world"}'),
		readingList([ARTICLE]),
	]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	assert.equal(ctx.notes, 1);
	assert.equal(ctx.failed.length, 1);
	assert.equal(ctx.skipped.length, 1);
});

test('copy mode writes a second note instead of matching the first', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));
	subject.duplicateHandling = DuplicateHandling.CreateCopy;

	await importing(subject, [readingList([ARTICLE])]);
	await importing(subject, [readingList([ARTICLE])]);

	assert.equal(vault.paths().length, 2);
});

test('a title spread over lines, or missing, still names a file', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page('<main><p>Body</p></main>'));

	await importing(subject, [readingList([
		{ title: 'PROJECT\nSort tasks', uuid: 'P', url: 'https://omni.example/actions.html' },
		{ title: '', uuid: 'U', url: 'https://news.example.org/a/b' },
	])]);

	assert.deepEqual(vault.paths(), [
		'Reading List/PROJECT Sort tasks.md',
		'Reading List/news.example.org.md',
	]);
});
