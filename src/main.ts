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

export interface AppleNotesHeadlessOptions {
	/** Vault folder to import into; created if missing. Defaults to "Apple Notes". */
	outputFolder?: string;
}

export interface AppleNotesHeadlessReport {
	outputFolder: string;
	imported: number;
	attachments: number;
	skipped: number;
	failed: number;
	cancelled: boolean;
	finishedAt: string;
}

export interface ImporterApi {
	importAppleNotes(options?: AppleNotesHeadlessOptions): Promise<AppleNotesHeadlessReport>;
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

		// The importer only touches `modal.contentEl` while building its (unused)
		// configuration UI during init(); import() itself never uses the modal.
		// A throwaway element lets init() run harmlessly with no modal open.
		const modalStub = { contentEl: createDiv(), plugin: this } as unknown as ImporterModal;
		const importer = new AppleNotesImporter(this.app, modalStub);
		if (importer.notAvailable) {
			throw new Error('Apple Notes import is only available in Obsidian desktop on macOS.');
		}
		importer.outputLocation = outputFolder;

		const ctx = new ImportContext(createDiv());
		await importer.import(ctx);

		return {
			outputFolder,
			imported: ctx.notes,
			attachments: ctx.attachments,
			skipped: ctx.skipped.length,
			failed: ctx.failed.length,
			cancelled: ctx.cancelled,
			finishedAt: new Date().toISOString(),
		};
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
