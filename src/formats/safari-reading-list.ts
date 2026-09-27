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
	linkMarkdown,
	NoteKind,
	noteKindFor,
	parseReadingList,
	ReadingListItem,
	readingListFrontMatter,
	readingListTitle,
	readingListVariables,
	stubMarkdown,
	templateSafe,
	uuidv7,
	whyThisLink,
} from './safari-reading-list/convert';

const DEFAULT_OUTPUT_FOLDER = 'Reading List';
const FETCH_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_500;
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';

interface ResolvedItem {
	markdown: string;
	variables: Record<string, unknown>;
	status: ImportStatus;
	/** Why the page did not arrive, when it did not. */
	failure?: string;
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

	/**
	 * Which kind of note each item becomes: a clipping that preserves the page,
	 * or a link that curates a pointer to it. Clippings by default, because an
	 * import exists to bring the material in. A page that did not arrive is a
	 * link whatever this says — there is nothing to preserve. Set in init() for
	 * the same reason as `fetchContent`.
	 */
	noteKind: NoteKind;

	init(): void {
		this.fetchContent = true;
		this.noteKind = 'clipping';
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
			?.setName(i18n.importer.safariReadingList.nameNoteKind())
			.setDesc(i18n.importer.safariReadingList.descNoteKind())
			.addDropdown(dropdown => {
				dropdown.addOption('clipping', i18n.importer.safariReadingList.optionClipping());
				dropdown.addOption('link', i18n.importer.safariReadingList.optionLink());
				dropdown.setValue(this.noteKind);
				dropdown.onChange(value => {
					this.noteKind = value === 'link' ? 'link' : 'clipping';
					this.templateSettingsChanged();
				});
			});

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
				const path = this.sanitizeFilePath(`${this.outputLocation}/${title}.md`);
				const body = noteBody(item, resolved, this.noteKind);
				samples.push({
					title,
					path,
					content: serializeFrontMatter(readingListFrontMatter(
						item, resolved.status, resolved.variables, this.noteKind,
						{ title: basenameOf(path), uid: uuidv7(), now: new Date() },
					)) + body,
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

		// The body is planned before the frontmatter exists, because the note's own
		// name is part of its frontmatter and only planning settles the name.
		const body = noteBody(item, resolved, this.noteKind);
		const sourceId = canonicalUrl(item.url);
		const ctime = parseTime(item.dateAdded);
		const planned = await this.planTemplatedNote(folder, readingListTitle(item, extractedTitle(resolved)), body, {
			sourceId,
			templateVariables: resolved.variables,
			ctime,
		});
		const already = planned.file ? this.noteKindOf(planned.file) : null;

		// The page holds material and this run could not reach it: keep what is
		// there. Overwriting it with a pointer would lose the page AND leave a note
		// that looks imported, so no later run would fetch it again.
		if (resolved.status === 'unresolved' && planned.file && already !== 'link') {
			ctx.reportSkipped(name, i18n.importer.safariReadingList.reasonKeptImported());
			return;
		}

		const content = serializeFrontMatter(readingListFrontMatter(
			item,
			resolved.status,
			resolved.variables,
			this.noteKind,
			{
				// The note's name is its filename, which is what the linter keeps
				// these two matching; its identity is minted once and then kept.
				title: basenameOf(planned.targetPath),
				uid: (planned.file && this.uidOf(planned.file)) || uuidv7(),
				now: new Date(),
			},
		)) + body;

		// A pointer being replaced by the page itself must be written, so the
		// content is compared. Otherwise the item's own date stands as the note's
		// source time, which leaves an unchanged page alone and preserves anything
		// written into the note by hand.
		const mtime = already === 'link' ? undefined : ctime;
		const { written } = await this.writePlannedNote(ctx, planned, content, {
			sourceId,
			templateVariables: resolved.variables,
			ctime,
			mtime,
		});
		if (written) ctx.reportNoteSuccess(name);
	}

	/** Which kind of note an earlier run left here, read from its own `type`. */
	private noteKindOf(file: TFile): NoteKind | null {
		const type: unknown = this.app.metadataCache?.getFileCache(file)?.frontmatter?.type;
		if (typeof type !== 'string') return null;

		return type === 'Note/Link' ? 'link' : 'clipping';
	}

	private uidOf(file: TFile): string | null {
		const uid: unknown = this.app.metadataCache?.getFileCache(file)?.frontmatter?.uid;
		return typeof uid === 'string' && uid ? uid : null;
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

		return {
			markdown,
			variables: readingListVariables(item, 'fetched', templateSafe(variables)),
			status: 'fetched',
		};
	}
}

function stub(item: ReadingListItem, failure?: string): ResolvedItem {
	return {
		markdown: stubMarkdown(item, failure),
		variables: readingListVariables(item, 'unresolved'),
		status: 'unresolved',
		failure,
	};
}

/**
 * The note as it will be written: the frontmatter its class declares, then the
 * body that kind of note carries. A clipping's body is the page, verbatim,
 * because preserving what the source said is the only thing a clipping is for.
 * A link's body is the vault's link shape: the pointer, why it is here, and its
 * status — no material, whether or not the page arrived.
 */
function noteBody(item: ReadingListItem, resolved: ResolvedItem, asked: NoteKind): string {
	return noteKindFor(asked, resolved.status) === 'clipping'
		? resolved.markdown
		: linkMarkdown(item, whyThisLink(item, resolved.failure));
}

/** A vault path's filename without its extension, which is the note's name. */
function basenameOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.replace(/\.md$/iu, '');
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
