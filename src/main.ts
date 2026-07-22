import { App, getLanguage, Modal, Notice, Platform, Plugin } from 'obsidian';
import { FormatImporter, ImporterHost } from './format-importer';
import { NodePickedFile } from './filesystem';
import { AuthCallback } from './constants';
import { ImportContext } from './import-context';
import { DEFAULT_DATA, ImporterData } from './plugin-data';
import { ImporterDefinition, IMPORTERS, importerName } from './importers';
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
	/** moment.js date-prefix format for filenames (e.g. "YYYY-MM-DD"); "" = none. Default "YYYY-MM-DD". */
	filePrefixFormat?: string;
	/** What to do with each source Apple Note after import. Default "none". */
	sourceDisposition?: AppleNotesDisposition;
	/** Apple Notes folder that imported notes are moved into when disposition is "move". Default "Exported". */
	exportedFolder?: string;
	/** Preview only — count what disposition WOULD move/delete, without touching Notes. */
	dispositionDryRun?: boolean;
}

export interface AppleNotesHeadlessReport {
	outputFolder: string;
	filePrefixFormat: string;
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

export interface ImporterApi {
	importAppleNotes(options?: AppleNotesHeadlessOptions): Promise<AppleNotesHeadlessReport>;
}

/**
 * Builds the AppleScript that moves imported source notes into an Exported
 * folder, or deletes them (to Recently Deleted). Only notes not modified since
 * `before` are affected. In dry-run it returns the count that would be touched.
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

	if (mode === 'delete') {
		return [
			'tell application "Notes"',
			'\t' + cutoff,
			'\tset doomed to (notes whose modification date ≤ cutoff)',
			`\tif ${dryRun ? 'true' : 'false'} then return (count of doomed)`,
			'\tset n to 0',
			'\trepeat with x in doomed',
			'\t\tdelete x',
			'\t\tset n to n + 1',
			'\tend repeat',
			'\treturn n',
			'end tell',
		].join('\n');
	}

	return [
		'tell application "Notes"',
		`\tif not (exists folder "${exp}") then make new folder with properties {name:"${exp}"}`,
		`\tset target to folder "${exp}"`,
		'\t' + cutoff,
		'\tset toMove to {}',
		'\trepeat with x in notes',
		`\t\tif (modification date of x) ≤ cutoff and name of (container of x) is not "${exp}" then set end of toMove to x`,
		'\tend repeat',
		`\tif ${dryRun ? 'true' : 'false'} then return (count of toMove)`,
		'\trepeat with x in toMove',
		'\t\tmove x to target',
		'\tend repeat',
		'\treturn (count of toMove)',
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
		const filePrefixFormat = options.filePrefixFormat ?? 'YYYY-MM-DD';
		const disposition: AppleNotesDisposition = options.sourceDisposition ?? 'none';
		const exportedFolder = options.exportedFolder?.trim() || 'Exported';
		const dispositionDryRun = options.dispositionDryRun ?? false;

		// The importer only touches `modal.contentEl` while building its (unused)
		// configuration UI during init(); import() itself never uses the modal.
		// A throwaway element lets init() run harmlessly with no modal open.
		const modalStub = { contentEl: createDiv(), plugin: this } as unknown as ImporterModal;
		const importer = new AppleNotesImporter(this.app, modalStub);
		if (importer.notAvailable) {
			throw new Error('Apple Notes import is only available in Obsidian desktop on macOS.');
		}
		importer.outputLocation = outputFolder;
		importer.filePrefixFormat = filePrefixFormat;
		// When moving imported notes into an "Exported" folder, that folder must be
		// skipped on import — otherwise its notes re-import into a subfolder.
		if (disposition === 'move') {
			importer.excludeFolderNames = [exportedFolder];
		}

		// Notes not modified since we start are safely captured by this import;
		// notes touched during it are left for the next run (so disposition never
		// removes an un-imported note).
		const startedAt = new Date();
		const ctx = new ImportContext(createDiv());
		await importer.import(ctx);

		let disposed = 0;
		if (disposition !== 'none' && !ctx.cancelled) {
			disposed = await this.disposeAppleNotes(disposition, startedAt, exportedFolder, dispositionDryRun);
		}

		return {
			outputFolder,
			filePrefixFormat,
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
	 * After a successful import, move or delete the source Apple Notes via
	 * AppleScript (Notes.app), so they are not re-imported next run. Only notes
	 * not modified since `before` are touched. Returns how many were moved/
	 * deleted — or, in dry-run, how many WOULD be. Desktop-only.
	 *
	 * Note: "delete" sends notes to Recently Deleted (30-day recovery), which the
	 * importer already skips. "move" relies on `excludeFolderNames` skipping the
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
