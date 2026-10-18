import '../shims/runtime';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import * as nodeZlib from 'node:zlib';

import { provideNodeModules } from '../../src/filesystem';
import { DuplicateHandling } from '../../src/format-importer';
import { importing } from './importing';
import { CORETIME_OFFSET, NoteSpec } from './store';

provideNodeModules({ fs: nodeFs as never, os: nodeOs, path: nodePath, zlib: nodeZlib });

const OLD = 700000000;
const NEW = 700003600;
const NOTES: NoteSpec[] = [
	{ title: 'Old', runs: [{ text: 'Old\n' }, { text: 'kept out' }], modified: OLD },
	{ title: 'New', runs: [{ text: 'New\n' }, { text: 'brought in' }], modified: NEW },
];
const ms = (apple: number) => (apple + CORETIME_OFFSET) * 1000;

/** Run import() itself on the fixture store, the way the headless API does. */
async function importAll(changedAfter: number | null) {
	const run = await importing(NOTES, DuplicateHandling.Update);
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
