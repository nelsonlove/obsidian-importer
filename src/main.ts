import { App, getLanguage, Modal, Notice, Platform, Plugin } from 'obsidian';
import { DuplicateHandling, FormatImporter, ImporterHost } from './format-importer';
import { NodePickedFile } from './filesystem';
import { AuthCallback } from './constants';
import { ImportContext } from './import-context';
import { DEFAULT_DATA, ImporterData } from './plugin-data';
import { ImporterDefinition, IMPORTERS, importerName } from './importers';
import { AppleNotesImporter } from './formats/apple-notes';
import { SafariReadingListImporter } from './formats/safari-reading-list';
import { ImporterFlow, ImporterShell } from './importer-flow';
import { ImporterSettingTab } from './importer-setting-tab';
import { i18n, setLanguage } from './i18n';
import { CHANGED_AFTER_MARGIN_MS, parseChangedAfter, runComplete } from './formats/apple-notes/headless';
import { describeReason } from './util';

declare global {
	interface Window {
		electron: {
			remote: {
				dialog: {
					showOpenDialogSync(options: Record<string, unknown>): string[] | undefined;
				};
			};
			webUtils?: {
				getPathForFile(file: File): string;
			};
		};
		require: NodeJS.Require;
	}
}

export type { AppleNotesDisposition } from './formats/apple-notes/headless';
import type { AppleNotesDisposition } from './formats/apple-notes/headless';

export interface AppleNotesHeadlessOptions {
	/** Vault folder to import into; created if missing. Defaults to "Apple Notes". */
	outputFolder?: string;
	/**
	 * Template for the imported note's title. Default `"{{title}}"` — the Apple Note's own title.
	 *
	 * This replaces the old `filePrefixFormat` date-prefix option. Upstream 3.x dropped the prefix
	 * field entirely in favour of a full title template, so a date prefix is now written as one:
	 * `'{{ctime | date:"YYYY-MM-DD"}} {{title}}'` reproduces exactly what
	 * `filePrefixFormat: "YYYY-MM-DD"` used to do. The template is strictly more expressive — it can
	 * place the date anywhere in the title, or key off something other than the creation time.
	 *
	 * Upstream does still read a stored bare prefix and wrap it into this shape, but only as a
	 * migration shim for its own saved settings. A headless caller should pass the template.
	 */
	noteTitleTemplate?: string;
	/** What to do with each source Apple Note after import. Default "none". */
	sourceDisposition?: AppleNotesDisposition;
	/** Apple Notes folder that imported notes are moved into when disposition is "move". Default "Exported". */
	exportedFolder?: string;
	/** Preview only — count what disposition WOULD move/delete, without touching Notes. */
	dispositionDryRun?: boolean;
	/**
	 * Read only the notes modified after this time (an ISO 8601 date-time with its
	 * offset or Z, or ms since the epoch as a number): new notes and edited ones. Older notes are not read, so a vault
	 * copy that was filed away or deleted on purpose is not brought back by a
	 * scheduled run. Not combinable with a source disposition, which would act on
	 * the older notes this run did not import. With it set, duplicate handling is
	 * Update and the source id is recorded, whatever the dialog saved, so a
	 * scheduled run never adds a second copy. Default: every note, as before.
	 */
	changedAfter?: string | number;
}

export interface AppleNotesHeadlessReport {
	outputFolder: string;
	noteTitleTemplate: string;
	imported: number;
	attachments: number;
	skipped: number;
	failed: number;
	cancelled: boolean;
	disposition: AppleNotesDisposition;
	dispositionDryRun: boolean;
	disposed: number;
	/** The changedAfter cut-off used, as ISO 8601, or null when every note was read. */
	changedAfter: string | null;
	/**
	 * True only when every selected note was read to the end, none failed and
	 * none was skipped for a reason a later run could clear (a locked note, an
	 * attachment not yet downloaded from iCloud).
	 */
	complete: boolean;
	/** When this run started, as ISO 8601. */
	startedAt: string;
	/**
	 * The cut-off a caller can pass as changedAfter next time, as it is: one hour
	 * before startedAt when the run was complete, else null (keep the old
	 * cut-off, so nothing is lost). The hour covers a note from another device
	 * that reaches this Mac through iCloud later than its modification time.
	 */
	nextChangedAfter: string | null;
	finishedAt: string;
}

export interface ReadingListHeadlessOptions {
	/** Absolute path of the JSON that `safari --json reading-list` wrote. */
	manifestPath: string;
	/** Vault folder to import into; created if missing. Defaults to "Reading List". */
	outputFolder?: string;
	/** Template for each note's title. Default `"{{title}}"`, the Reading List item's title. */
	noteTitleTemplate?: string;
	/** Fetch each page and keep its content; false writes link stubs only. Default true. */
	fetchContent?: boolean;
	/**
	 * Which kind of note each item becomes: "clipping" preserves the page,
	 * "link" curates a pointer to it. Default "clipping". A page that cannot be
	 * fetched is imported as a link either way.
	 */
	noteKind?: 'clipping' | 'link';
}

export interface ReadingListOutcome {
	/** The item, by the name the import reported it under. */
	name: string;
	reason: string;
}

export interface ReadingListHeadlessReport {
	manifestPath: string;
	outputFolder: string;
	noteTitleTemplate: string;
	fetchContent: boolean;
	noteKind: 'clipping' | 'link';
	imported: number;
	skipped: number;
	failed: number;
	/**
	 * What failed and why, and what was passed over and why. Counts alone say
	 * nothing a caller can act on: a headless run has no report note and no
	 * dialog to read, so the reasons come back with the numbers.
	 */
	failures: ReadingListOutcome[];
	skips: ReadingListOutcome[];
	cancelled: boolean;
	finishedAt: string;
}

export interface ImporterApi {
	importAppleNotes(options?: AppleNotesHeadlessOptions): Promise<AppleNotesHeadlessReport>;
	importReadingList(options: ReadingListHeadlessOptions): Promise<ReadingListHeadlessReport>;
	/** What this build's headless API understands, so a caller can check before it runs. */
	supports: { appleNotesChangedAfter: boolean };
}

/** What an import reported under one outcome, as plain strings a caller can read. */
function outcomesIn(ctx: ImportContext, outcome: 'failed' | 'skipped'): ReadingListOutcome[] {
	return ctx.log
		.filter(entry => entry.outcome === outcome)
		.map(({ name, reason }) => ({ name, reason: describeReason(reason) }));
}

/**
 * Builds the AppleScript that moves imported source notes into an Exported
 * folder, or deletes them (to Recently Deleted). Only notes not modified since
 * `before` are affected, and the "Shared" and "Recently Deleted" folders (plus
 * the Exported target, in move mode) are never touched. In dry-run it returns
 * the count that would be touched via a count-only script that emits no
 * mutating statements.
 */
function buildDispositionScript(
	mode: 'move' | 'delete',
	before: Date,
	exportedFolder: string,
	dryRun: boolean
): string {
	const tod = before.getHours() * 3600 + before.getMinutes() * 60 + before.getSeconds();
	const exp = exportedFolder.replace(/["\\]/g, '');
	const cutoff = [
		'set cutoff to current date',
		`set year of cutoff to ${before.getFullYear()}`,
		`set month of cutoff to ${before.getMonth() + 1}`,
		`set day of cutoff to ${before.getDate()}`,
		`set time of cutoff to ${tod}`,
	].join('\n\t');

	// Folders disposition never touches. "Recently Deleted" is already excluded
	// from Notes' app-level `folders`, but we guard it explicitly; "Shared" holds
	// notes shared with other people. In move mode the Exported target is also
	// skipped so already-moved notes aren't re-moved. Names are matched literally,
	// so a non-English Notes UI would need localized names here.
	const protectedFolders = mode === 'move' ? [exp, 'Shared', 'Recently Deleted'] : ['Shared', 'Recently Deleted'];
	const notExcluded = protectedFolders.map((name) => `fn is not "${name}"`).join(' and ');

	if (dryRun) {
		// Count-only: no delete/move/make statements are emitted, so a dry-run
		// provably cannot mutate Notes.
		return [
			'tell application "Notes"',
			'\t' + cutoff,
			'\tset n to 0',
			'\trepeat with f in folders',
			'\t\tset fn to name of f',
			`\t\tif ${notExcluded} then`,
			'\t\t\trepeat with x in (notes of f)',
			'\t\t\t\tif modification date of x ≤ cutoff then set n to n + 1',
			'\t\t\tend repeat',
			'\t\tend if',
			'\tend repeat',
			'\treturn n',
			'end tell',
		].join('\n');
	}

	const action = mode === 'delete' ? 'delete x' : `move x to folder "${exp}"`;
	const ensureTarget = mode === 'move'
		? [`\tif not (exists folder "${exp}") then make new folder with properties {name:"${exp}"}`]
		: [];
	return [
		'tell application "Notes"',
		...ensureTarget,
		'\t' + cutoff,
		'\tset n to 0',
		'\trepeat with f in folders',
		'\t\tset fn to name of f',
		`\t\tif ${notExcluded} then`,
		// Snapshot the folder's notes and iterate in reverse so deleting/moving a
		// note doesn't shift the indices of ones not yet processed.
		'\t\t\tset ns to notes of f',
		'\t\t\trepeat with i from (count of ns) to 1 by -1',
		'\t\t\t\tset x to item i of ns',
		'\t\t\t\tif modification date of x ≤ cutoff then',
		`\t\t\t\t\t${action}`,
		'\t\t\t\t\tset n to n + 1',
		'\t\t\t\tend if',
		'\t\t\tend repeat',
		'\t\tend if',
		'\tend repeat',
		'\treturn n',
		'end tell',
	].join('\n');
}

export default class ImporterPlugin extends Plugin {
	importers: Record<string, ImporterDefinition>;

	authCallback: AuthCallback | undefined;

	private handledAuthState: string | undefined;

	private modal: ImporterModal | null = null;

	private settingTab: ImporterSettingTab;
	/** Programmatic entry points for automations (e.g. TaskNotes Workflows). */
	api: ImporterApi;

	async onload() {
		setLanguage(getLanguage());

		this.importers = IMPORTERS;

		this.settingTab = new ImporterSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addRibbonIcon('lucide-import', i18n.command.importNotes(), () => {
			this.openImporter();
		});

		this.addCommand({
			id: 'open-modal',
			name: i18n.command.importNotes(),
			callback: () => {
				this.openImporter();
			},
		});

		this.api = {
			importAppleNotes: (options = {}) => this.importAppleNotesHeadless(options),
			importReadingList: options => this.importReadingListHeadless(options),
			supports: { appleNotesChangedAfter: true },
		};

		this.addCommand({
			id: 'apple-notes-headless',
			name: i18n.command.importAppleNotes(),
			callback: async () => {
				try {
					const report = await this.importAppleNotesHeadless();
					new Notice(i18n.command.msgAppleNotesDone({
						imported: report.imported,
						attachments: report.attachments,
						skipped: report.skipped,
						failed: report.failed,
					}));
				}
				catch (error) {
					new Notice(i18n.command.msgAppleNotesFailed({
						reason: error instanceof Error ? error.message : String(error),
					}));
					console.error('[importer] apple-notes-headless failed', error);
				}
			},
		});

		this.registerObsidianProtocolHandler('importer-auth',
			(data) => {
				if (this.authCallback) {
					this.handledAuthState = data['state'];
					this.authCallback(data);
					this.authCallback = undefined;
					return;
				}

				// Browsers may open the same callback URI twice.
				if (data['state'] && data['state'] === this.handledAuthState) return;

				new Notice(i18n.modal.msgUnexpectedAuth());
			});
	}

	openImporter(): void {
		if (Platform.isMobile) {
			this.settingTab.open();
			return;
		}

		if (this.modal) {
			this.modal.show();
			return;
		}

		this.modal = new ImporterModal(this.app, this);
		this.modal.open();
	}

	forgetImporter(modal: ImporterModal): void {
		if (this.modal === modal) {
			this.modal = null;
		}
	}

	onunload() {

	}

	/**
	 * Runs the Apple Notes importer without opening the modal, into
	 * `outputFolder` (created if needed), and resolves with a summary. Exposed on
	 * `this.api.importAppleNotes` and via the `importer:apple-notes-headless`
	 * command so automations (TaskNotes Workflows, etc.) can trigger it and await
	 * completion. Incremental by default — notes unchanged since their existing
	 * file are skipped by the importer.
	 */
	async importAppleNotesHeadless(options: AppleNotesHeadlessOptions = {}): Promise<AppleNotesHeadlessReport> {
		const outputFolder = options.outputFolder?.trim() || 'Apple Notes';
		const noteTitleTemplate = options.noteTitleTemplate?.trim() || '{{title}}';
		const disposition: AppleNotesDisposition = options.sourceDisposition ?? 'none';
		const exportedFolder = options.exportedFolder?.trim() || 'Exported';
		const dispositionDryRun = options.dispositionDryRun ?? false;
		const changedAfter = parseChangedAfter(options.changedAfter, disposition);

		// A host with null step elements runs the importer with no UI: draw() and
		// addSetting() no-op against a null stepEl, and loadFolders() only feeds
		// the (undrawn) picker.
		const host: ImporterHost = {
			sourceEl: null,
			outputEl: null,
			optionsEl: null,
			plugin: this,
			importerId: 'apple-notes',
			abortController: new AbortController(),
		};
		const importer = new AppleNotesImporter(this.app, host);
		await importer.ready;
		if (importer.notAvailable) {
			throw new Error('Apple Notes import is only available in Obsidian desktop on macOS.');
		}
		importer.outputLocation = outputFolder;
		// Set AFTER `ready`: the importer's own setup reads a saved title template out of
		// localStorage, so assigning before it would be silently overwritten.
		importer.noteTitleTemplate = noteTitleTemplate;
		if (changedAfter !== null) {
			importer.changedAfter = changedAfter;
			// Pinned for a scheduled run, for the reason given on the Safari path
			// below: a saved "Create copy" would add a file on every run, and the
			// recorded id is what finds a note again after it was moved.
			importer.duplicateHandling = DuplicateHandling.Update;
			importer.saveSourceId = true;
		}
		// The picker normally decides selectedFolders; headless selects everything
		// importable. When moving imported notes into an "Exported" folder, that
		// folder is skipped — otherwise its notes re-import into a subfolder.
		const selected = await importer.selectAllFolders(disposition === 'move' ? [exportedFolder] : []);
		if (selected === 0) {
			throw new Error('No importable Apple Notes folders found. Grant Notes access once via the Importer dialog first.');
		}

		// Notes not modified since we start are safely captured by this import;
		// notes touched during it are left for the next run (so disposition never
		// removes an un-imported note).
		const startedAt = new Date();
		const ctx = new ImportContext();
		// The two steps the modal's flow performs around an import, and a headless
		// run needs just as much: the index is what lets an earlier note be found
		// by its recorded ID rather than only by its path, so a note that has since
		// been renamed is updated instead of duplicated.
		importer.indexImportedNotes();
		await importer.import(ctx);
		await importer.finalizeMarkdownOutput(ctx);

		const complete = runComplete({
			completed: importer.completed,
			cancelled: ctx.cancelled,
			failed: ctx.failed.length,
			locked: importer.locked,
			notDownloaded: importer.notDownloaded,
		});

		let disposed = 0;
		if (disposition !== 'none' && !ctx.cancelled) {
			disposed = await this.disposeAppleNotes(disposition, startedAt, exportedFolder, dispositionDryRun);
		}

		return {
			outputFolder,
			noteTitleTemplate,
			imported: ctx.notes,
			attachments: ctx.attachments,
			skipped: ctx.skipped.length,
			failed: ctx.failed.length,
			cancelled: ctx.cancelled,
			disposition,
			dispositionDryRun,
			disposed,
			changedAfter: changedAfter === null ? null : new Date(changedAfter).toISOString(),
			complete,
			startedAt: startedAt.toISOString(),
			nextChangedAfter: complete ? new Date(startedAt.getTime() - CHANGED_AFTER_MARGIN_MS).toISOString() : null,
			finishedAt: new Date().toISOString(),
		};
	}

	/**
	 * Runs the Safari Reading List importer without opening the modal, on the
	 * JSON at `manifestPath`, into `outputFolder` (created if needed), and
	 * resolves with a summary. Exposed on `this.api.importReadingList` so an
	 * automation can trigger it and await completion. Notes are matched across
	 * runs by their source URL, so re-running with the same export is safe.
	 */
	async importReadingListHeadless(options: ReadingListHeadlessOptions): Promise<ReadingListHeadlessReport> {
		const manifestPath = options.manifestPath?.trim();
		if (!manifestPath) throw new Error('manifestPath is required: the JSON that `safari --json reading-list` wrote.');
		const outputFolder = options.outputFolder?.trim() || 'Reading List';
		const noteTitleTemplate = options.noteTitleTemplate?.trim() || '{{title}}';
		const fetchContent = options.fetchContent ?? true;
		const noteKind = options.noteKind === 'link' ? 'link' : 'clipping';

		const host: ImporterHost = {
			sourceEl: null,
			outputEl: null,
			optionsEl: null,
			plugin: this,
			importerId: 'safari-reading-list',
			abortController: new AbortController(),
		};
		const importer = new SafariReadingListImporter(this.app, host);
		await importer.ready;
		importer.outputLocation = outputFolder;
		// Set AFTER `ready`, for the same reason as the Apple Notes path above.
		importer.noteTitleTemplate = noteTitleTemplate;
		importer.fetchContent = fetchContent;
		importer.noteKind = noteKind;
		// Pinned, not inherited: `ready` loads whatever was last chosen in the
		// dialog, and a saved "Create copy" would add a file on every headless run
		// while a saved "Skip" could never update one. Recording the source URL is
		// what matches a note on the next run, so it is not optional here either.
		importer.duplicateHandling = DuplicateHandling.Update;
		importer.saveSourceId = true;
		importer.files = [new NodePickedFile(manifestPath)];

		const ctx = new ImportContext();
		importer.indexImportedNotes();
		await importer.import(ctx);
		await importer.finalizeMarkdownOutput(ctx);

		return {
			manifestPath,
			outputFolder,
			noteTitleTemplate,
			fetchContent,
			noteKind,
			imported: ctx.notes,
			skipped: ctx.skipped.length,
			failed: ctx.failed.length,
			failures: outcomesIn(ctx, 'failed'),
			skips: outcomesIn(ctx, 'skipped'),
			cancelled: ctx.cancelled,
			finishedAt: new Date().toISOString(),
		};
	}

	/**
	 * After a successful import, move or delete the source Apple Notes via
	 * AppleScript (Notes.app), so they are not re-imported next run. Only notes
	 * not modified since `before` are touched. Returns how many were moved/
	 * deleted — or, in dry-run, how many WOULD be. Desktop-only.
	 *
	 * Note: "delete" sends notes to Recently Deleted (30-day recovery), which the
	 * importer already skips. "move" relies on `selectAllFolders` skipping the
	 * Exported folder on subsequent imports.
	 */
	private async disposeAppleNotes(
		mode: 'move' | 'delete',
		before: Date,
		exportedFolder: string,
		dryRun: boolean
	): Promise<number> {
		const nodeRequire =
			typeof window !== 'undefined'
				? (window as unknown as { require?: (id: string) => unknown }).require
				: undefined;
		if (typeof nodeRequire !== 'function') {
			throw new Error('Apple Notes disposition requires desktop Obsidian (Node).');
		}
		type ExecFileFn = (
			file: string,
			args: readonly string[],
			options: { timeout?: number, maxBuffer?: number },
			callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
		) => void;
		const { execFile } = nodeRequire('child_process') as { execFile: ExecFileFn };

		const script = buildDispositionScript(mode, before, exportedFolder, dryRun);
		const out = await new Promise<string>((resolve, reject) => {
			execFile('osascript', ['-e', script], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) reject(new Error((stderr || '').trim() || error.message));
				else resolve(String(stdout).trim());
			});
		});
		return parseInt(out, 10) || 0;
	}

	async loadData(): Promise<ImporterData> {
		return Object.assign({}, DEFAULT_DATA, await super.loadData());
	}

	async saveData(data: ImporterData): Promise<void> {
		await super.saveData(data);
	}

	/**
	 * Register a function to be called when the `obsidian://importer-auth/` open
	 * event is received by Obsidian.
	 *
	 * Note: The callback will be cleared after being called. It must be
	 * reregistered if a subsequent auth event is expected.
	 */
	public registerAuthCallback(callback: AuthCallback): void {
		this.authCallback = callback;
	}

	public async runImport(
		importerId: string,
		filepaths: string[],
		outputLocation: string,
		configure?: (importer: FormatImporter) => void
	): Promise<ImportContext> {
		if (!Platform.isDesktopApp) {
			throw new Error('An import driven by a script reads files from disk, which needs the desktop app.');
		}

		const definition = this.importers[importerId];
		if (!definition) {
			throw new Error(`No importer called "${importerId}". One of: ${Object.keys(this.importers).join(', ')}`);
		}

		const host: ImporterHost = {
			sourceEl: null,
			outputEl: null,
			optionsEl: null,
			plugin: this,
			importerId,
			helpPermalink: definition.helpPermalink,
			abortController: new AbortController(),
		};

		const importer = new definition.importer(this.app, host);

		await importer.ready;

		if (importer.notAvailable) {
			throw new Error(`The ${importerName(importerId)} importer is not available here.`);
		}

		if (importer.requiresImporterConfiguration) {
			throw new Error(`The ${importerName(importerId)} importer is configured on a second screen, which an import without the dialog cannot show yet.`);
		}

		importer.files = filepaths.map(filepath => new NodePickedFile(filepath));
		importer.outputLocation = outputLocation;
		configure?.(importer);

		const ctx = new ImportContext();
		try {
			importer.indexImportedNotes();
			await importer.import(ctx);
		}
		finally {
			await importer.finalizeMarkdownOutput(ctx);
		}
		return ctx;
	}
}

export class ImporterModal extends Modal implements ImporterShell {
	plugin: ImporterPlugin;
	flow: ImporterFlow;

	readonly ownsBackButton: boolean = false;

	readonly ownsFocus: boolean = true;

	private hidden: boolean = false;

	constructor(app: App, plugin: ImporterPlugin) {
		super(app);
		this.plugin = plugin;
		this.modalEl.addClass('mod-importer');
		this.flow = new ImporterFlow(app, plugin, this);
		this.catchBackgroundClick();
	}

	setScreen(depth: number, title: string): void {
		this.setTitle(title);
	}

	setPickingFormat(picking: boolean): void {
		this.modalEl.toggleClass('is-picking-format', picking);
	}

	adoptButtonBar(barEl: HTMLElement | null): void {
		if (barEl) this.contentEl.append(barEl);
	}

	finish(): void {
		this.close();
	}

	foreground(): void {
		this.show();
	}

	hide() {
		if (this.hidden) return;
		this.hidden = true;
		this.containerEl.hide();

		// The hidden modal must not keep intercepting Escape.
		this.app.keymap.popScope(this.scope);

		this.flow.detach();
	}

	show() {
		if (!this.hidden) return;
		this.hidden = false;
		this.containerEl.show();
		this.app.keymap.pushScope(this.scope);

		this.flow.attach();
	}

	private catchBackgroundClick() {
		// Run before Modal's outside-click handler closes the import.
		this.containerEl.addEventListener('click', evt => {
			if (!this.flow.importing) return;
			if (evt.target instanceof Node && this.modalEl.contains(evt.target)) return;

			evt.preventDefault();
			evt.stopPropagation();
			this.hide();
		}, { capture: true });
	}

	onOpen() {
		this.flow.attach();
	}

	onEscapeKey(evt: KeyboardEvent) {
		if (evt.defaultPrevented) return;
		evt.preventDefault();
		if (this.flow.importing) this.hide();
		else this.close();
	}

	onClose() {
		this.contentEl.empty();
		this.hidden = false;
		this.plugin.forgetImporter(this);
		this.flow.dispose();
	}
}
