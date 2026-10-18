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
	{ title: 'Old', runs: [{ text: 'Old\n' }, { text: 'kept out' }], created: OLD },
	{ title: 'New', runs: [{ text: 'New\n' }, { text: 'brought in' }], created: NEW },
];
const ms = (apple: number) => (apple + CORETIME_OFFSET) * 1000;

test('with no cut-off, every note is kept', async () => {
	const run = await importing(NOTES, DuplicateHandling.Update);
	try {
		const rows = run.notePks.map(Z_PK => ({ Z_PK }));
		assert.deepEqual(await run.subject.keepCreatedAfter(rows), rows);
	}
	finally {
		run.close();
	}
});

test('a cut-off keeps only the notes created after it', async () => {
	const run = await importing(NOTES, DuplicateHandling.Update);
	try {
		run.subject.createdAfter = ms(OLD + 1800);
		const rows = run.notePks.map(Z_PK => ({ Z_PK }));
		assert.deepEqual(await run.subject.keepCreatedAfter(rows), [rows[1]]);
	}
	finally {
		run.close();
	}
});

test('a note created exactly at the cut-off is left out', async () => {
	const run = await importing(NOTES, DuplicateHandling.Update);
	try {
		run.subject.createdAfter = ms(NEW);
		const rows = run.notePks.map(Z_PK => ({ Z_PK }));
		assert.deepEqual(await run.subject.keepCreatedAfter(rows), []);
	}
	finally {
		run.close();
	}
});

test('the creation time is read as the importer dates the note', async () => {
	const run = await importing(NOTES, DuplicateHandling.Update);
	try {
		assert.equal(await run.subject.noteCreatedAt(run.notePks[1]), ms(NEW));
	}
	finally {
		run.close();
	}
});
