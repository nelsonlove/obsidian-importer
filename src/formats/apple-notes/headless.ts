/**
 * The parts of the headless Apple Notes import that need no app: reading the
 * changedAfter option and deciding whether a run was complete. Kept apart from
 * main.ts so tests can load them.
 */

export type AppleNotesDisposition = 'none' | 'move' | 'delete';

/** How far back nextChangedAfter goes from a run's start, for notes that reach this Mac late through iCloud. */
export const CHANGED_AFTER_MARGIN_MS = 60 * 60 * 1000;

/**
 * Read a changedAfter option: null when not given; else ms since the epoch.
 * A string must be an ISO 8601 date-time with an offset or Z, so it never
 * depends on the Mac's time zone; a number must be milliseconds (a value that
 * reads as seconds is refused). It cannot be combined with a source
 * disposition, which acts on every note older than the run, including the ones
 * the cut-off kept out of it.
 */
export function parseChangedAfter(value: string | number | undefined | null, disposition: AppleNotesDisposition): number | null {
	if (value === undefined || value === null || value === '') return null;
	let ms: number;
	if (typeof value === 'number') {
		ms = value;
		// Before 1973 in ms is after 5138 in s: a value this small is seconds.
		if (!Number.isFinite(ms) || ms < 1e11) throw new Error(`changedAfter must be milliseconds since the epoch: ${value}`);
	}
	else {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
			throw new Error(`changedAfter must be an ISO 8601 date-time with an offset or Z: ${value}`);
		}
		ms = Date.parse(value);
	}
	if (Number.isNaN(new Date(ms).getTime())) throw new Error(`changedAfter is not a valid date: ${String(value)}`);
	if (disposition !== 'none') {
		throw new Error('changedAfter cannot be combined with a source disposition; use sourceDisposition "none".');
	}
	return ms;
}

/** Whether a run read everything it should, so a caller may move its cut-off. */
export function runComplete(run: { completed: boolean, cancelled: boolean, failed: number, locked: number, notDownloaded: number }): boolean {
	return run.completed && !run.cancelled && run.failed === 0 && run.locked === 0 && run.notDownloaded === 0;
}
