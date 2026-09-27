import { App, getLanguage, Modal, Notice, Platform, Plugin } from 'obsidian';
import { FormatImporter, ImporterHost } from './format-importer';
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

export type AppleNotesDisposition = 'none' | 'move' | 'delete';

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
}

export interface ReadingListHeadlessReport {
	manifestPath: string;
	outputFolder: string;
	noteTitleTemplate: string;
	fetchContent: boolean;
	imported: number;
	skipped: number;
	failed: number;
	cancelled: boolean;
	finishedAt: string;
}

export interface ImporterApi {
	importAppleNotes(options?: AppleNotesHeadlessOptions): Promise<AppleNotesHeadlessReport>;
	importReadingList(options: ReadingListHeadlessOptions): Promise<ReadingListHeadlessReport>;
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
		};

		this.addCommand({
			id: 'apple-notes-headless',
			name: 'Import Apple Notes (headless)',
			callback: async () => {
				try {
					const report = await this.importAppleNotesHeadless();
					new Notice(
						`Apple Notes: imported ${report.imported}, ${report.attachments} attachments, ` +
						`${report.skipped} skipped, ${report.failed} failed.`
					);
				}
				catch (error) {
					new Notice(`Apple Notes import failed: ${error instanceof Error ? error.message : String(error)}`);
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
		await importer.import(ctx);

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
			imported: ctx.notes,
			skipped: ctx.skipped.length,
			failed: ctx.failed.length,
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
