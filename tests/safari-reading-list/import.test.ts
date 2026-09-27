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

test('the same page saved again matches its note and leaves it as it is', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));
	await importing(subject, [readingList([ARTICLE])]);
	const before = note(vault, 'Reading List/An article.md');

	// A fresh UUID, other tracking parameters and a new title, but the same
	// canonical URL, so it is the same note — matched by the recorded source URL
	// and not written again, so the import does not churn.
	const again = { ...ARTICLE, uuid: 'A-2', url: 'https://example.com/article?utm_campaign=y', title: 'An article, retitled' };
	answerRequests(() => page(ARTICLE_HTML.replace(/An article/gu, 'An article, retitled')));
	const ctx = await importing(subject, [readingList([again])]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	assert.equal(note(vault, 'Reading List/An article.md'), before);
	assert.equal(ctx.notes, 0);
	assert.equal(ctx.skipped.length, 1);
	assert.deepEqual(ctx.failed, []);
});

test('a page that cannot be fetched on a later run never replaces the content already imported', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));
	await importing(subject, [readingList([ARTICLE])]);
	const imported = note(vault, 'Reading List/An article.md');
	assert.match(imported, /The body text of the article/u);

	// The site is down this time. The note holds the page; a stub would lose it
	// and, being a note with the same source URL, would look imported forever.
	answerRequests(() => page('down', 503));
	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.equal(note(vault, 'Reading List/An article.md'), imported);
	assert.equal(ctx.notes, 0);
	assert.equal(ctx.skipped.length, 1);
	assert.deepEqual(ctx.failed, []);
});

test('a stub is replaced by the page once it can be fetched', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page('gone', 404));
	await importing(subject, [readingList([ARTICLE])]);
	assert.match(note(vault, 'Reading List/An article.md'), /\nimport-status: unresolved\n/u);

	answerRequests(() => page(ARTICLE_HTML));
	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	const upgraded = note(vault, 'Reading List/An article.md');
	assert.match(upgraded, /\nimport-status: fetched\n/u);
	assert.match(upgraded, /The body text of the article/u);
	assert.equal(ctx.notes, 1);
});

test('a note written after the page was saved is left alone', async () => {
	const { vault, subject } = importer();
	// A note that already sits where this item would land, touched more recently
	// than Safari saved the item: the item's own date is what the import compares
	// against, so anything newer is the reader's and is kept.
	const mine = 'My own note about that article.\n';
	await vault.create('Reading List/An article.md', mine, { ctime: Date.now(), mtime: Date.now() });
	answerRequests(() => page(ARTICLE_HTML));

	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.equal(note(vault, 'Reading List/An article.md'), mine);
	assert.equal(ctx.notes, 0);
	assert.deepEqual(ctx.failed, []);
});

test('a network failure is retried, and then leaves a stub saying so', async () => {
	const { vault, subject } = importer();
	let asked = 0;
	answerRequests(() => {
		asked++;
		// Not a status: offline, DNS, a refused connection. requestUrl rejects.
		throw new Error('net::ERR_NAME_NOT_RESOLVED');
	});

	const ctx = await importing(subject, [readingList([ARTICLE])]);

	assert.equal(asked, 2);
	assert.match(note(vault, 'Reading List/An article.md'), /ERR_NAME_NOT_RESOLVED/u);
	assert.deepEqual(ctx.failed, []);
});

test('the fetch toggle reports the state the import will actually use', async () => {
	const { subject } = importer();
	await subject.ready;

	// The base class calls init() from its constructor, so a field initializer
	// would still be undefined while the toggle was being drawn.
	assert.equal(subject.fetchContent, true);
});

test('two entries for one page in the same file import once, and the second is reported', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page(ARTICLE_HTML));

	const ctx = await importing(subject, [readingList([
		ARTICLE,
		{ ...ARTICLE, uuid: 'A-3', url: 'https://example.com/article#section' },
	])]);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	assert.equal(ctx.skipped.length, 1);
});

test('hash-routed pages are separate pages', async () => {
	const { vault, subject } = importer();
	answerRequests(() => page('<main><p>Body</p></main>'));

	await importing(subject, [readingList([
		{ title: 'Topic A', uuid: 'H-1', url: 'https://groups.example.com/g/x#!topic/a' },
		{ title: 'Topic B', uuid: 'H-2', url: 'https://groups.example.com/g/x#!topic/b' },
	])]);

	assert.deepEqual(vault.paths(), ['Reading List/Topic A.md', 'Reading List/Topic B.md']);
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

test('a server error retried after the import was stopped writes no stub', async () => {
	const { vault, subject } = importer();
	const ctx = new ImportContext();
	let asked = 0;
	answerRequests(() => {
		asked++;
		// The server failed, so the fetch will be retried; the user stops the import
		// during the pause before that retry. The page's fate is unknown at that
		// point, and a stub would record a failure the next run has no reason to
		// retry, so nothing is written.
		ctx.cancel();
		return page('busy', 503);
	});

	await subject.ready;
	subject.files = [readingList([ARTICLE])];
	subject.outputLocation = 'Reading List';
	subject.indexImportedNotes();
	await subject.import(ctx);

	assert.equal(asked, 1);
	assert.deepEqual(vault.paths(), []);
	assert.deepEqual(ctx.failed, []);
});

test('a page whose fetch finishes is still written when the import is stopped during it', async () => {
	const { vault, subject } = importer();
	const ctx = new ImportContext();
	answerRequests(() => {
		// The content did arrive, so it is kept: an item already begun finishes,
		// which is how the other importers behave.
		ctx.cancel();
		return page(ARTICLE_HTML);
	});

	await subject.ready;
	subject.files = [readingList([ARTICLE])];
	subject.outputLocation = 'Reading List';
	subject.indexImportedNotes();
	await subject.import(ctx);

	assert.deepEqual(vault.paths(), ['Reading List/An article.md']);
	assert.match(note(vault, 'Reading List/An article.md'), /\nimport-status: fetched\n/u);
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
