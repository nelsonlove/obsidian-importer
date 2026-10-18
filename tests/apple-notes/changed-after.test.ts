import '../shims/runtime';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import * as nodeZlib from 'node:zlib';

import { provideNodeModules } from '../../src/filesystem';
import { DuplicateHandling } from '../../src/format-importer';
import { CHANGED_AFTER_MARGIN_MS, parseChangedAfter, runComplete } from '../../src/formats/apple-notes/headless';
import { importing } from './importing';
import { ANAttachment, AttachmentSpec, CORETIME_OFFSET, NoteSpec } from './store';

provideNodeModules({ fs: nodeFs as never, os: nodeOs, path: nodePath, zlib: nodeZlib });

const OLD = 700000000;
const NEW = 700003600;
const NOTES: NoteSpec[] = [
	{ title: 'Old', runs: [{ text: 'Old\n' }, { text: 'kept out' }], modified: OLD },
	{ title: 'New', runs: [{ text: 'New\n' }, { text: 'brought in' }], modified: NEW },
];
const ms = (apple: number) => (apple + CORETIME_OFFSET) * 1000;

/** Run import() itself on the fixture store, the way the headless API does. */
async function importAll(changedAfter: number | null, notes: NoteSpec[] = NOTES, attachments?: AttachmentSpec[]) {
	const run = await importing(notes, DuplicateHandling.Update, { attachments });
	const subject = run.subject as any;
	subject.changedAfter = changedAfter;
	subject.selectedFolders = [run.folderPk];
	subject.getOutputFolder = async () => run.vault.root;
	subject.getNotesDatabase = async () => subject.database;
	subject.resolveAccount = async () => {};
	subject.resolveFolder = async () => run.vault.root;
	await subject.import(run.ctx);
	return run;
}

test('with no cut-off, every note is imported', async () => {
	const run = await importAll(null);
	try {
		assert.deepEqual(run.vault.paths().sort(), ['New.md', 'Old.md']);
		assert.equal((run.subject as any).completed, true);
	}
	finally {
		run.close();
	}
});

test('a cut-off imports only the notes modified after it', async () => {
	const run = await importAll(ms(OLD + 1800));
	try {
		assert.deepEqual(run.vault.paths(), ['New.md']);
		assert.equal((run.subject as any).completed, true);
	}
	finally {
		run.close();
	}
});

test('a note modified exactly at the cut-off is left out', async () => {
	const run = await importAll(ms(NEW));
	try {
		assert.deepEqual(run.vault.paths(), []);
	}
	finally {
		run.close();
	}
});

test('a row with no modification time is kept, since it cannot be shown to be old', async () => {
	const run = await importing(NOTES, DuplicateHandling.Update);
	try {
		run.subject.changedAfter = ms(NEW + 1);
		const rows = [{ Z_PK: 1, ZMODIFICATIONDATE1: null }, { Z_PK: 2, ZMODIFICATIONDATE1: OLD }];
		assert.deepEqual(run.subject.keepChangedAfter(rows), [rows[0]]);
	}
	finally {
		run.close();
	}
});

test('with a cut-off, an older note that a new note links to is not written', async () => {
	const notes: NoteSpec[] = [
		{ title: 'Old', identifier: '00000000-0000-0000-0000-0000000000AA', runs: [{ text: 'Old\n' }, { text: 'filed away' }], modified: OLD },
		{
			title: 'New', modified: NEW, runs: [
				{ text: 'New\n' },
				{ text: 'see ' },
				{ text: '', attachment: { identifier: 'LINK-1', uti: ANAttachment.InternalLink } },
			],
		},
	];
	const attachments: AttachmentSpec[] = [
		{ identifier: 'LINK-1', uti: ANAttachment.InternalLink, tokenContentIdentifier: 'applenotes:note/00000000-0000-0000-0000-0000000000aa' },
	];
	const run = await importAll(ms(OLD + 1800), notes, attachments);
	try {
		assert.deepEqual(run.vault.paths(), ['New.md']);
		assert.match(String(run.vault.contents.get('New.md')), /\(unknown file link\)/);
	}
	finally {
		run.close();
	}
});

test('changedAfter: an offset date-time or a millisecond number, nothing else', () => {
	assert.equal(parseChangedAfter(undefined, 'none'), null);
	assert.equal(parseChangedAfter('', 'none'), null);
	assert.equal(parseChangedAfter('2026-10-18T04:00:00Z', 'none'), Date.UTC(2026, 9, 18, 4));
	assert.equal(parseChangedAfter('2026-10-18T00:00:00-04:00', 'none'), Date.UTC(2026, 9, 18, 4));
	assert.equal(parseChangedAfter(Date.UTC(2026, 9, 18, 4), 'none'), Date.UTC(2026, 9, 18, 4));
	assert.throws(() => parseChangedAfter('2026-10-18T00:00:00', 'none'), /offset/);
	assert.throws(() => parseChangedAfter('2026-10-18', 'none'), /offset/);
	assert.throws(() => parseChangedAfter('1760000000000', 'none'), /offset/);
	assert.throws(() => parseChangedAfter(1760000000, 'none'), /milliseconds/);
	assert.throws(() => parseChangedAfter(Number.NaN, 'none'), /milliseconds/);
	assert.throws(() => parseChangedAfter(1e20, 'none'), /not a valid date/);
});

test('changedAfter is refused with a source disposition, before anything runs', () => {
	assert.throws(() => parseChangedAfter('2026-10-18T04:00:00Z', 'delete'), /disposition/);
	assert.throws(() => parseChangedAfter('2026-10-18T04:00:00Z', 'move'), /disposition/);
	assert.equal(parseChangedAfter(undefined, 'delete'), null);
});

test('a run is complete only when nothing is left for a later run', () => {
	const clean = { completed: true, cancelled: false, failed: 0, locked: 0, notDownloaded: 0 };
	assert.equal(runComplete(clean), true);
	assert.equal(runComplete({ ...clean, completed: false }), false);
	assert.equal(runComplete({ ...clean, cancelled: true }), false);
	assert.equal(runComplete({ ...clean, failed: 1 }), false);
	assert.equal(runComplete({ ...clean, locked: 1 }), false);
	assert.equal(runComplete({ ...clean, notDownloaded: 1 }), false);
	assert.equal(CHANGED_AFTER_MARGIN_MS, 3600000);
});
