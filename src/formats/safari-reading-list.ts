import { Notice, requestUrl, RequestUrlResponse, TFile, TFolder } from 'obsidian';
import { decodeText } from '../encoding';
import { FormatImporter, NoteTemplateSample, TEMPLATE_PREVIEW_LIMIT } from '../format-importer';
import { i18n } from '../i18n';
import { ImportContext } from '../import-context';
import { extractErrorMessage, serializeFrontMatter } from '../util';
import { convertHtmlDocument } from './html/convert';
import {
	canonicalUrl,
	ImportStatus,
	parseReadingList,
	ReadingListItem,
	readingListFrontMatter,
	readingListTitle,
	readingListVariables,
	stubMarkdown,
} from './safari-reading-list/convert';

const DEFAULT_OUTPUT_FOLDER = 'Reading List';
const FETCH_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_500;
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';

interface ResolvedItem {
	markdown: string;
	variables: Record<string, unknown>;
	status: ImportStatus;
}

/** A fetch worth one more try: the server, not the page, said no. */
class RetryableError extends Error {}

/** The import was stopped while this page was in flight. */
class CancelledError extends Error {}

/** What `resolve` answers when the import was stopped: write nothing. */
const CANCELLED = Symbol('cancelled');

/**
 * Imports a Safari Reading List from the JSON that safari-py exports. Each
 * item's page is fetched and its main content extracted the way the HTML
 * importer does; a page that does not arrive becomes a stub note rather than
 * a skipped item. Notes are matched across runs by the page's canonical URL,
 * recorded in the source-ID property.
 */
export class SafariReadingListImporter extends FormatImporter {
	static extensions = ['json'];

	interruption = 'pause' as const;

	/**
	 * Fetch each page and keep its content; off writes link stubs only. Set in
	 * init(), not here: the base class calls init() from its constructor, before
	 * a subclass field initializer would run.
	 */
	fetchContent: boolean;

	init(): void {
		this.fetchContent = true;
		this.idProperty = 'source-url';
		this.idLabel = i18n.importer.safariReadingList.labelId();
		this.duplicateCaveat = i18n.importer.safariReadingList.descSourceIdentity();

		this.addExportSetting(i18n.importer.safariReadingList.descExport());
		this.addFileChooserSetting(
			i18n.importer.safariReadingList.fileType(),
			SafariReadingListImporter.extensions,
			true,
			i18n.importer.safariReadingList.descFiles(),
		);

		this.addSetting()
			?.setName(i18n.importer.safariReadingList.nameFetchContent())
			.setDesc(i18n.importer.safariReadingList.descFetchContent())
			.addToggle(toggle => {
				toggle.setValue(this.fetchContent);
				toggle.onChange(value => {
					this.fetchContent = value;
					this.templateSettingsChanged();
				});
			});

		this.defaultOutputFolder = DEFAULT_OUTPUT_FOLDER;
	}

	async import(ctx: ImportContext): Promise<void> {
		if (this.files.length === 0) {
			new Notice(i18n.common.msgPickFile());
			return;
		}

		const folder = await this.getOutputFolder();
		if (!folder) {
			new Notice(i18n.common.msgPickOutput());
			return;
		}

		const items = await this.loadItems(ctx);
		ctx.reportProgress(0, items.length);
		for (let index = 0; index < items.length; index++) {
			if (await ctx.shouldStop()) return;

			const item = items[index];
			try {
				await this.importItem(ctx, folder, item);
			}
			catch (error) {
				ctx.reportFailed(item.url, error);
			}
			ctx.reportProgress(index + 1, items.length);
		}
	}

	protected override async templatePreviewSamples(ctx: ImportContext): Promise<NoteTemplateSample[]> {
		const samples: NoteTemplateSample[] = [];
		for (const item of await this.loadItems(ctx)) {
			if (samples.length >= TEMPLATE_PREVIEW_LIMIT || await ctx.shouldStop()) break;
			try {
				const resolved = await this.resolve(ctx, item);
				if (resolved === CANCELLED) break;
				const title = readingListTitle(item, extractedTitle(resolved));
				samples.push({
					title,
					path: this.sanitizeFilePath(`${this.outputLocation}/${title}.md`),
					content: noteContent(item, resolved),
					variables: resolved.variables,
					sourceId: canonicalUrl(item.url),
					times: { ctime: parseTime(item.dateAdded) },
				});
			}
			catch (error) {
				console.warn(`Could not preview Reading List item ${item.url}`, error);
			}
		}
		return samples;
	}

	/**
	 * Every item across the chosen files, one per canonical URL. A file that
	 * is not a Reading List export is reported and the others still import.
	 */
	private async loadItems(ctx: ImportContext): Promise<ReadingListItem[]> {
		const seen = new Set<string>();
		const items: ReadingListItem[] = [];

		for (const file of this.files) {
			let parsed: ReadingListItem[];
			try {
				parsed = parseReadingList(await file.readText());
			}
			catch (error) {
				ctx.reportFailed(file.fullpath, error);
				continue;
			}

			if (parsed.length === 0) {
				ctx.reportSkipped(file.fullpath, i18n.importer.safariReadingList.reasonNoItems());
				continue;
			}

			for (const item of parsed) {
				const key = canonicalUrl(item.url);
				// Said out loud rather than dropped quietly: two entries that look
				// like one page may not be one page, and a silently vanished item
				// still leaves the totals adding up.
				if (seen.has(key)) {
					ctx.reportSkipped(readingListTitle(item), i18n.importer.safariReadingList.reasonSameAddress());
					continue;
				}
				seen.add(key);
				items.push(item);
			}
		}

		return items;
	}

	private async importItem(ctx: ImportContext, folder: TFolder, item: ReadingListItem): Promise<void> {
		const name = readingListTitle(item);
		ctx.status(i18n.importer.safariReadingList.statusFetching({ name }));

		const resolved = await this.resolve(ctx, item);
		// A fetch stopped part-way is not an unresolved page: writing a stub for it
		// would record a failure the next run has no reason to retry.
		if (resolved === CANCELLED) return;

		const content = noteContent(item, resolved);
		const sourceId = canonicalUrl(item.url);
		const ctime = parseTime(item.dateAdded);
		const planned = await this.planTemplatedNote(folder, readingListTitle(item, extractedTitle(resolved)), content, {
			sourceId,
			templateVariables: resolved.variables,
			ctime,
		});
		const already = planned.file ? this.importStatusOf(planned.file) : null;

		// The page holds content and this run could not reach it: keep what is
		// there. Overwriting it with a stub would lose the page AND make the note
		// look imported, so no later run would fetch it again.
		if (resolved.status === 'unresolved' && planned.file && already !== 'unresolved') {
			ctx.reportSkipped(name, i18n.importer.safariReadingList.reasonKeptImported());
			return;
		}

		// A stub being replaced by the real page must be written, so the content is
		// compared. Otherwise the item's own date stands as the note's source time,
		// which leaves an unchanged page alone and preserves anything Nelson wrote
		// into the note himself.
		const mtime = already === 'unresolved' ? undefined : ctime;
		const { written } = await this.writePlannedNote(ctx, planned, content, {
			sourceId,
			templateVariables: resolved.variables,
			ctime,
			mtime,
		});
		if (written) ctx.reportNoteSuccess(name);
	}

	/** What an earlier run recorded about this note, or null if nothing did. */
	private importStatusOf(file: TFile): string | null {
		const status: unknown = this.app.metadataCache?.getFileCache(file)?.frontmatter?.['import-status'];
		return typeof status === 'string' && status ? status : null;
	}

	private async resolve(ctx: ImportContext, item: ReadingListItem): Promise<ResolvedItem | typeof CANCELLED> {
		if (!this.fetchContent) return stub(item);

		let html: string;
		try {
			html = await fetchHtml(item.url, () => ctx.isCancelled());
		}
		catch (error) {
			if (error instanceof CancelledError) return CANCELLED;
			return stub(item, extractErrorMessage(error) ?? String(error));
		}

		const { markdown, variables } = await convertHtmlDocument(html, {
			baseUrl: new URL(item.url),
			extractMainContent: true,
			isCancelled: () => ctx.isCancelled(),
			// Images stay as links to where they are; nothing is downloaded.
			resolveAttachment: async () => null,
		});

		return { markdown, variables: readingListVariables(item, 'fetched', variables), status: 'fetched' };
	}
}

function stub(item: ReadingListItem, failure?: string): ResolvedItem {
	return {
		markdown: stubMarkdown(item, failure),
		variables: readingListVariables(item, 'unresolved'),
		status: 'unresolved',
	};
}

function noteContent(item: ReadingListItem, resolved: ResolvedItem): string {
	return serializeFrontMatter(readingListFrontMatter(item, resolved.status, resolved.variables)) + resolved.markdown;
}

function extractedTitle(resolved: ResolvedItem): string | undefined {
	const { title } = resolved.variables;
	return typeof title === 'string' ? title : undefined;
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const time = Date.parse(value);
	return Number.isNaN(time) ? undefined : time;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === wanted) return headers[key];
	}
	return undefined;
}

async function withTimeout<T>(work: Promise<T> | T, ms: number): Promise<T> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new RetryableError(`timed out after ${ms / 1000}s`)), ms);
	});
	try {
		return await Promise.race([Promise.resolve(work), timeout]);
	}
	finally {
		if (timer !== undefined) window.clearTimeout(timer);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

/**
 * The page as HTML text, or an error saying why not. A 5xx or a timeout gets
 * one more try; a 4xx does not, since the page said no. `requestUrl` is not
 * bound by browser CORS rules, so this works for any site.
 */
/**
 * The page's response, where a failure to reach the server at all — offline,
 * DNS, a refused connection, a bad certificate — is reported as worth another
 * try. That failure arrives as a thrown error rather than as a status, which is
 * the case most worth retrying and the easiest to mistake for a page saying no.
 */
async function requestPage(url: string): Promise<RequestUrlResponse> {
	try {
		return await withTimeout(requestUrl({ url, throw: false, headers: { Accept: ACCEPT } }), FETCH_TIMEOUT_MS);
	}
	catch (error) {
		throw error instanceof RetryableError
			? error
			: new RetryableError(extractErrorMessage(error) ?? 'the request failed');
	}
}

async function fetchHtml(url: string, isCancelled: () => boolean): Promise<string> {
	let lastError: unknown;

	for (let attempt = 0; attempt < 2; attempt++) {
		if (isCancelled()) throw new CancelledError('cancelled');
		try {
			const response = await requestPage(url);
			if (response.status >= 500) throw new RetryableError(`HTTP ${response.status}`);
			if (response.status >= 400) throw new Error(`HTTP ${response.status}`);

			const contentType = headerValue(response.headers, 'content-type') ?? '';
			if (contentType && !/html|xml/iu.test(contentType)) {
				throw new Error(`not HTML (${contentType.split(';')[0].trim()})`);
			}

			return decodeText(new Uint8Array(response.arrayBuffer));
		}
		catch (error) {
			lastError = error;
			if (!(error instanceof RetryableError)) throw error;
			// No point pausing after the last attempt.
			if (attempt === 0) await sleep(RETRY_DELAY_MS);
		}
	}

	throw lastError;
}
