/**
 * The pure half of the Safari Reading List importer: no vault, no network.
 *
 * The input is what safari-py prints with `safari --json reading-list`: an
 * `{ status, data: [...] }` envelope around the items. A bare array and a
 * manifest with `items` (the reading-list-import charter's shape) are read
 * the same way, and the plist extras safari-py may add later (`site_name`,
 * `image_url`, `date_last_viewed`) are picked up when present.
 */
import type { FrontMatterCache } from 'obsidian';

export interface ReadingListItem {
	/** Safari's `WebBookmarkUUID`, or the manifest `id`; the URL when neither is given. */
	uuid: string;
	url: string;
	title: string;
	/** ISO 8601, as the export wrote it. */
	dateAdded?: string;
	previewText?: string;
	siteName?: string;
	imageUrl?: string;
	/** Safari's `DateLastViewed`: the item was opened at least once. */
	dateLastViewed?: string;
}

/** Whether the page's content reached the note, or only what Safari knew. */
export type ImportStatus = 'fetched' | 'unresolved';

/** Query parameters that only track the click, never select the content. */
const TRACKING_PARAMS = /^(?:utm_\w+|fbclid|gclid|dclid|msclkid|igshid|yclid|mc_cid|mc_eid|_ga|_hsenc|_hsmi|ref_src|s_kwcid)$/iu;

function text(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function webUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
	}
	catch {
		return null;
	}
}

/**
 * The items in an export. Entries without a web URL are dropped: a decade-old
 * list has junk in it, and one bad entry must not stop the rest.
 */
export function parseReadingList(json: string): ReadingListItem[] {
	const parsed: unknown = JSON.parse(json);
	const list = listIn(parsed);
	if (!list) {
		throw new Error('Not a Reading List export: expected an array of items, or an object holding one as "data" or "items"');
	}

	const items: ReadingListItem[] = [];
	for (const entry of list) {
		const item = readItem(entry);
		if (item) items.push(item);
	}
	return items;
}

function listIn(parsed: unknown): unknown[] | null {
	if (Array.isArray(parsed)) return parsed;
	if (!parsed || typeof parsed !== 'object') return null;

	const record = parsed as Record<string, unknown>;
	if (Array.isArray(record.data)) return record.data;
	if (Array.isArray(record.items)) return record.items;
	return null;
}

function readItem(entry: unknown): ReadingListItem | null {
	if (!entry || typeof entry !== 'object') return null;
	const record = entry as Record<string, unknown>;

	const url = text(record.url);
	if (!url || !webUrl(url)) return null;

	return {
		uuid: text(record.uuid) ?? text(record.id) ?? url,
		url,
		title: text(record.title) ?? '',
		dateAdded: text(record.date_added) ?? text(record.dateAdded),
		previewText: text(record.preview_text) ?? text(record.previewText),
		siteName: text(record.site_name) ?? text(record.siteName),
		imageUrl: text(record.image_url) ?? text(record.imageUrl) ?? text(record.imageURL),
		dateLastViewed: text(record.date_last_viewed) ?? text(record.dateLastViewed),
	};
}

/**
 * The URL as a dedupe key: the same page saved twice, once with a campaign
 * tag and once with a fragment, is one note. Anything that is not a web URL
 * is returned as it came.
 */
export function canonicalUrl(value: string): string {
	const url = webUrl(value);
	if (!url) return value;

	url.hash = '';
	url.hostname = url.hostname.toLowerCase();

	const kept = [...url.searchParams].filter(([key]) => !TRACKING_PARAMS.test(key));
	url.search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';

	if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
		url.pathname = url.pathname.slice(0, -1);
	}

	return url.href;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

/**
 * The note's title: what Safari showed, on one line; the page's own title
 * when Safari had none; the host as a last resort.
 */
export function readingListTitle(item: ReadingListItem, extractedTitle?: string): string {
	const title = collapseWhitespace(item.title) || collapseWhitespace(extractedTitle ?? '');
	if (title) return title;

	return webUrl(item.url)?.hostname ?? item.url;
}

/**
 * What a template can reach for. Everything Defuddle extracted comes first;
 * the item's own facts, and its import status, sit on top under stable names.
 */
export function readingListVariables(
	item: ReadingListItem,
	status: ImportStatus,
	extracted: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		...extracted,
		uuid: item.uuid,
		url: item.url,
		canonicalUrl: canonicalUrl(item.url),
		domain: text(extracted.domain) ?? webUrl(item.url)?.hostname ?? '',
		title: readingListTitle(item, text(extracted.title)),
		dateAdded: item.dateAdded ?? '',
		previewText: item.previewText ?? '',
		siteName: item.siteName ?? text(extracted.site) ?? '',
		imageUrl: item.imageUrl ?? text(extracted.image) ?? '',
		dateLastViewed: item.dateLastViewed ?? '',
		read: Boolean(item.dateLastViewed),
		importStatus: status,
	};
}

/**
 * The generated frontmatter. Safari's facts win over the page's where both
 * exist; a key is written only when there is a value for it, except `read`
 * and `import-status`, which every note carries so a query can find the
 * unread and the unresolved.
 */
export function readingListFrontMatter(
	item: ReadingListItem,
	status: ImportStatus,
	extracted: Record<string, unknown> = {},
): FrontMatterCache {
	const frontMatter: Record<string, unknown> = { url: item.url };

	const site = item.siteName ?? text(extracted.site);
	if (site) frontMatter.site = site;
	const author = text(extracted.author);
	if (author) frontMatter.author = author;
	const published = text(extracted.published);
	if (published) frontMatter.published = published;
	const description = item.previewText ?? text(extracted.description);
	if (description) frontMatter.description = description;
	const image = item.imageUrl ?? text(extracted.image);
	if (image) frontMatter.image = image;
	if (item.dateAdded) frontMatter.added = item.dateAdded;
	if (item.dateLastViewed) frontMatter.viewed = item.dateLastViewed;
	frontMatter.read = Boolean(item.dateLastViewed);
	frontMatter['import-status'] = status;

	return frontMatter as FrontMatterCache;
}

function escapeLinkText(value: string): string {
	return value.replace(/([[\]\\])/gu, '\\$1');
}

/**
 * The body of a note whose page did not arrive. Not a failure: the stub is
 * searchable, records that the link existed, and can be retried later.
 */
export function stubMarkdown(item: ReadingListItem, failure?: string): string {
	const lines = [`[${escapeLinkText(readingListTitle(item))}](${item.url})`, ''];

	if (item.previewText) {
		lines.push(`> ${item.previewText.replace(/\s*\n\s*/gu, '\n> ')}`, '');
	}

	lines.push(failure ? `Content could not be fetched: ${failure}` : 'Content was not fetched.', '');

	return lines.join('\n');
}
