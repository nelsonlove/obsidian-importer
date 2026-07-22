import { App, Modal, Notice, Plugin, Setting } from 'obsidian';
import { FormatImporter } from './format-importer';
import { AppleNotesImporter } from './formats/apple-notes';
import { AppleJournalImporter } from './formats/apple-journal';
import { Bear2bkImporter } from './formats/bear-bear2bk';
import { CSVImporter } from './formats/csv';
import { EvernoteEnexImporter } from './formats/evernote-enex';
import { HtmlImporter } from './formats/html';
import { KeepImporter } from './formats/keep-json';
import { NotionImporter } from './formats/notion';
import { NotionAPIImporter } from './formats/notion-api';
import { OneNoteImporter } from './formats/onenote';
import { RoamJSONImporter } from './formats/roam-json';
import { TextbundleImporter } from './formats/textbundle';
import { TomboyImporter } from './formats/tomboy';
import { truncateText } from './util';

declare global {
	interface Window {
		electron: any;
		require: NodeRequire;
	}
}

interface ImporterDefinition {
	name: string;
	optionText: string;
	helpPermalink?: string;
	formatDescription?: string;
	importer: new (app: App, modal: ImporterModal) => FormatImporter;
}


/**
 * URI to use as the callback for OAuth applications.
 */
export const AUTH_REDIRECT_URI: string = 'obsidian://importer-auth/';

/**
 * List of accepted attachment extensions
 */
export const ATTACHMENT_EXTS = ['png', 'webp', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'mpg', 'm4a', 'webm', 'wav', 'ogv', '3gp', 'mov', 'mp4', 'mkv', 'pdf'];

/**
 * AuthCallback is a function which will be called when the importer-auth
 * protocal is opened by an OAuth callback.
 */
export type AuthCallback = (data: any) => void;

// Temporary compatibility for in progress PRs
export type ProgressReporter = ImportContext;

export class ImportContext {
	notes = 0;
	attachments = 0;
	skipped: string[] = [];
	failed: string[] = [];
	maxFileNameLength: number = 100;
	statusMessage: string = '';

	cancelled: boolean = false;

	el: HTMLElement;
	progressBarEl: HTMLElement;
	progressBarInnerEl: HTMLElement;
	importedCountEl: HTMLElement;
	attachmentCountEl: HTMLElement;
	remainingCountEl: HTMLElement;
	skippedCountEl: HTMLElement;
	failedCountEl: HTMLElement;
	statusEl: HTMLElement;
	importLogEl: HTMLElement;

	constructor(el: HTMLElement) {
		this.el = el;
		this.createProgressUI(el);
	}

	/**
	 * Creates the import progress UI.
	 * @param container The container element to create the UI in
	 */
	createProgressUI(container: HTMLElement) {
		container.empty();

		this.el = container;
		this.statusEl = container.createDiv('importer-status');

		this.progressBarEl = container.createDiv('importer-progress-bar', el => {
			this.progressBarInnerEl = el.createDiv('importer-progress-bar-inner');
		});

		container.createDiv('importer-stats-container', el => {
			el.createDiv('importer-stat mod-imported', el => {
				this.importedCountEl = el.createDiv({ cls: 'importer-stat-count', text: this.notes.toString() });
				el.createDiv({ cls: 'importer-stat-name', text: 'imported' });
			});
			el.createDiv('importer-stat mod-attachments', el => {
				this.attachmentCountEl = el.createDiv({ cls: 'importer-stat-count', text: this.attachments.toString() });
				el.createDiv({ cls: 'importer-stat-name', text: 'attachments' });
			});
			el.createDiv('importer-stat mod-remaining', el => {
				this.remainingCountEl = el.createDiv({ cls: 'importer-stat-count', text: '0' });
				el.createDiv({ cls: 'importer-stat-name', text: 'remaining' });
			});
			el.createDiv('importer-stat mod-skipped', el => {
				this.skippedCountEl = el.createDiv({ cls: 'importer-stat-count', text: this.skipped.length.toString() });
				el.createDiv({ cls: 'importer-stat-name', text: 'skipped' });
			});
			el.createDiv('importer-stat mod-failed', el => {
				this.failedCountEl = el.createDiv({ cls: 'importer-stat-count', text: this.failed.length.toString() });
				el.createDiv({ cls: 'importer-stat-name', text: 'failed' });
			});
		});

		this.importLogEl = container.createDiv('importer-log');
		this.importLogEl.hide();
	}

	/**
	 * Sets the current user visible in-progress task. The purpose is to tell the user that something is happening,
	 * and makes it easy to tell if something got stuck.
	 *
	 * Try to keep the message short, since longer ones will get truncated based on font and space availability.
	 * @param message
	 */
	status(message: string) {
		this.statusMessage = message;
		this.statusEl.setText(message.trim() + '...');
	}

	/**
	 * Report that a note has been successfully imported.
	 * @param name
	 */
	reportNoteSuccess(name: string) {
		this.notes++;
		this.importedCountEl.setText(this.notes.toString());
	}

	/**
	 * Report that an attachment has been successfully imported.
	 * @param name
	 */
	reportAttachmentSuccess(name: string) {
		this.attachments++;
		this.attachmentCountEl.setText(this.attachments.toString());
	}

	/**
	 * Report that something has been skipped and ignored.
	 * If the skipping action is on purpose and expected for the import, then prefer not to report it
	 * (for example, some tools export to a Note.json and a Note.html, and we only use one of them).
	 * @param name
	 * @param reason
	 */
	reportSkipped(name: string, reason?: any) {
		let { importLogEl } = this;
		this.skipped.push(name);
		this.skippedCountEl.setText(this.skipped.length.toString());

		console.log('Import skipped', name, reason);

		this.importLogEl.createDiv('list-item', el => {
			el.createSpan({ cls: 'importer-error', text: 'Skipped: ' });
			el.createSpan({ text: `"${truncateText(name, this.maxFileNameLength)}"` + (reason ? ` because ${truncateText(String(reason), this.maxFileNameLength)}` : '') });
		});
		importLogEl.scrollTop = importLogEl.scrollHeight;
		importLogEl.show();
	}

	/**
	 * Report that something has failed to import.
	 * @param name
	 * @param reason
	 */
	reportFailed(name: string, reason?: any) {
		let { importLogEl } = this;

		this.failed.push(name);
		this.failedCountEl.setText(this.failed.length.toString());

		console.log('Import failed', name, reason);

		this.importLogEl.createDiv('list-item', el => {
			el.createSpan({ cls: 'importer-error', text: 'Failed: ' });
			el.createSpan({ text: `"${truncateText(name, this.maxFileNameLength)}"` + (reason ? ` because ${truncateText(String(reason), this.maxFileNameLength)}` : '') });
		});
		importLogEl.scrollTop = importLogEl.scrollHeight;
		importLogEl.show();
	}

	/**
	 * Report the current progress. This will update the progress bar as well as changing
	 * the "imported" and "remaining" numbers on the UI.
	 * @param current
	 * @param total
	 */
	reportProgress(current: number, total: number) {
		if (total <= 0) return;
		console.log('Current progress:', (100 * current / total).toFixed(1) + '%');
		this.remainingCountEl.setText((total - current).toString());
		this.importedCountEl.setText(current.toString());
		this.progressBarInnerEl.style.width = (100 * current / total).toFixed(1) + '%';
	}

	cancel() {
		this.cancelled = true;
		this.progressBarEl.hide();
		this.statusEl.hide();
	}

	hideStatus() {
		this.progressBarEl.hide();
		this.statusEl.hide();
	}

	/**
	 * Check if the user has cancelled this run.
	 */
	isCancelled() {
		return this.cancelled;
	}
}

export interface ImporterData {
	importers: {
		onenote?: {
			previouslyImportedIDs: string[];
		};
	};
}

const DEFAULT_DATA: ImporterData = {
	importers: {
		onenote: {
			previouslyImportedIDs: [],
		},
	},
};

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

	/** Programmatic entry points for automations (e.g. TaskNotes Workflows). */
	api: ImporterApi;

	async onload() {
		this.importers = {
			'apple-notes': {
				name: 'Apple Notes',
				optionText: 'Apple Notes',
				importer: AppleNotesImporter,
				helpPermalink: 'import/apple-notes'
			},
			'apple-journal': {
				name: 'Apple Journal',
				optionText: 'Apple Journal (HTML export)',
				importer: AppleJournalImporter,
				formatDescription: 'Import your Journal app entries to Obsidian',
			},
			'bear': {
				name: 'Bear',
				optionText: 'Bear (.bear2bk)',
				importer: Bear2bkImporter,
				helpPermalink: 'import/bear',
			},
			'csv': {
				name: 'CSV',
				optionText: 'CSV (.csv)',
				importer: CSVImporter,
				helpPermalink: 'import/csv',
			},
			'evernote': {
				name: 'Evernote',
				optionText: 'Evernote (.enex)',
				importer: EvernoteEnexImporter,
				helpPermalink: 'import/evernote',
			},
			'keep': {
				name: 'Google Keep',
				optionText: 'Google Keep (.zip/.json)',
				importer: KeepImporter,
				helpPermalink: 'import/google-keep',
			},
			'html': {
				name: 'HTML files',
				optionText: 'HTML (.html)',
				importer: HtmlImporter,
				helpPermalink: 'import/html',
			},
			'onenote': {
				name: 'Microsoft OneNote',
				optionText: 'Microsoft OneNote',
				importer: OneNoteImporter,
				helpPermalink: 'import/onenote',
			},
			'notion-api': {
				name: 'Notion (API)',
				optionText: 'Notion (API)',
				importer: NotionAPIImporter,
				helpPermalink: 'import/notion',
			},
			'notion': {
				name: 'Notion',
				optionText: 'Notion (.zip)',
				importer: NotionImporter,
				helpPermalink: 'import/notion',
				formatDescription: 'Export your Notion workspace to HTML format.',
			},
			'roam-json': {
				name: 'Roam Research',
				optionText: 'Roam Research (.json)',
				importer: RoamJSONImporter,
				helpPermalink: 'import/roam',
				formatDescription: 'Export your Roam Research workspace to JSON format.',
			},
			'textbundle': {
				name: 'Textbundle files',
				optionText: 'Textbundle (.textbundle, .textpack)',
				importer: TextbundleImporter,
				helpPermalink: 'import/textbundle',
			},
			'tomboy': {
				name: 'Tomboy/Gnote',
				optionText: 'Tomboy/Gnote (.note)',
				importer: TomboyImporter,
			},
		};

		this.addRibbonIcon('lucide-import', 'Open Importer', () => {
			new ImporterModal(this.app, this).open();
		});

		this.addCommand({
			id: 'open-modal',
			name: 'Open importer',
			callback: () => {
				new ImporterModal(this.app, this).open();
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
					this.authCallback(data);
					this.authCallback = undefined;
					return;
				}

				new Notice('Unexpected auth event. Please restart the auth process.');
			});

		// For development, un-comment this and tweak it to your importer:

		/*
		// Create and open the importer on boot
		let modal = new ImporterModal(this.app, this);
		modal.open();
		// Select my importer
		modal.updateContent('html');
		if (modal.importer instanceof HtmlImporter) {
			// Automatically pick file
			modal.importer.files = [new NodePickedFile('path/to/test/file.html')];
		}
		*/
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
}

export class ImporterModal extends Modal {
	plugin: ImporterPlugin;
	importer: FormatImporter;
	selectedId: string;
	abortController: AbortController;

	current: ImportContext | null = null;

	constructor(app: App, plugin: ImporterPlugin) {
		super(app);
		this.plugin = plugin;
		this.titleEl.setText('Import data into Obsidian');
		this.modalEl.addClass('mod-importer');
		this.abortController = new AbortController();

		let keys = Object.keys(plugin.importers);
		if (keys.length > 0) {
			this.selectedId = keys[0];
			this.updateContent();
		}
	}

	updateContent() {
		const { contentEl, selectedId } = this;
		let importers = this.plugin.importers;
		let selectedImporter = importers[selectedId];
		contentEl.empty();

		let descriptionFragment = new DocumentFragment();
		descriptionFragment.createSpan({ text: 'The format to be imported.' });
		if (selectedImporter.formatDescription) {
			descriptionFragment.createEl('br');
			descriptionFragment.createSpan({ text: selectedImporter.formatDescription });
		}
		if (selectedImporter.helpPermalink) {
			descriptionFragment.createEl('br');
			descriptionFragment.createEl('a', {
				text: `Learn more about importing from ${selectedImporter.name}.`,
				href: `https://help.obsidian.md/${selectedImporter.helpPermalink}`,
			});
		}

		new Setting(contentEl)
			.setName('File format')
			.setDesc(descriptionFragment)
			.addDropdown(dropdown => {
				for (let id in importers) {
					if (importers.hasOwnProperty(id)) {
						dropdown.addOption(id, importers[id].optionText);
					}
				}
				dropdown.onChange((value) => {
					if (importers.hasOwnProperty(value)) {
						this.selectedId = value;
						this.updateContent();
					}
				});
				dropdown.setValue(this.selectedId);
			});

		if (selectedId && importers.hasOwnProperty(selectedId)) {
			let importer = this.importer = new selectedImporter.importer(this.app, this);

			//Hide the import buttons if it's not available.
			//The actual message to display is handled by the importer, since it depends on what is being imported.
			if (importer.notAvailable) return;

			contentEl.createDiv('modal-button-container', el => {
				el.createEl('button', { cls: 'mod-cta', text: 'Import' }, el => {
					el.addEventListener('click', async () => {
						if (this.current) {
							this.current.cancel();
						}

						// Clear content
						contentEl.empty();
						let configEl = contentEl.createDiv();
						let ctx = this.current = new ImportContext(configEl);

						// Check if importer needs template configuration
						const templateResult = await importer.showTemplateConfiguration(ctx, configEl);

						if (templateResult === false) {
							// User cancelled or preparation failed
							this.current = null;
							this.updateContent();
							return;
						}

						// Show progress UI
						contentEl.empty();
						let progressEl = contentEl.createDiv();
						ctx.createProgressUI(progressEl);

						let buttonsEl = contentEl.createDiv('modal-button-container');
						let cancelButtonEl = buttonsEl.createEl('button', { cls: 'mod-danger', text: 'Stop' }, el => {
							el.addEventListener('click', () => {
								ctx.cancel();
								cancelButtonEl.detach();
							});
						});
						try {
							await importer.import(ctx);
						}
						finally {
							if (this.current === ctx) {
								this.current = null;
							}
							buttonsEl.empty();
							buttonsEl.createEl('button', { text: 'Import more' }, el => {
								el.addEventListener('click', () => this.updateContent());
							});
							buttonsEl.createEl('button', { cls: 'mod-cta', text: 'Done' }, el => {
								el.addEventListener('click', () => this.close());
							});
							ctx.hideStatus();
						}
					});
				});
			});
		}
	}

	onClose() {
		const { contentEl, current } = this;
		contentEl.empty();
		this.abortController.abort('import was canceled by user');

		if (current) {
			current.cancel();
		}
	}
}
