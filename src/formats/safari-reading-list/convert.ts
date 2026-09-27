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
 * A fragment that selects the page rather than a place within it, as the older
 * hash-routed sites use: `#!topic/x`, `#/inbox`. Dropping one of these merges
 * pages that are not the same page, so it is kept.
 */
function routesThePage(hash: string): boolean {
	return hash.startsWith('#!') || hash.startsWith('#/');
}

/**
 * The URL as a dedupe key: the same page saved twice, once with a campaign
 * tag and once with a fragment, is one note. Anything that is not a web URL
 * is returned as it came.
 *
 * Deliberately not normalized: the scheme, so a page saved as http and later as
 * https stays two notes rather than risking two different pages becoming one —
 * a spare note is cheap and a lost one is not.
 */
export function canonicalUrl(value: string): string {
	const url = webUrl(value);
	if (!url) return value;

	if (!routesThePage(url.hash)) url.hash = '';

	// Credentials identify a visitor, not a page, and must not reach a note.
	url.username = '';
	url.password = '';

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
 * The whole raw page, which the extractor returns beside its findings. It is of
 * no use in a note template and on a large commercial page it runs to megabytes,
 * so it never reaches the template layer.
 */
const NEVER_A_TEMPLATE_VARIABLE = ['fullHtml'];

/**
 * The template engine refuses to render a value past a few million characters,
 * and it refuses the whole render rather than that one value — which would cost
 * the note, title and body alike. So anything absurd for a template to hold is
 * left out well below that limit.
 */
const LONGEST_TEMPLATE_VALUE = 1_000_000;

/**
 * What the extractor found, less anything that would cost the note. A page whose
 * own content is larger than this cannot be templated at all, so dropping the
 * value is the difference between a note with a plain title and no note.
 */
export function templateSafe(extracted: Record<string, unknown>): Record<string, unknown> {
	const safe: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(extracted)) {
		if (NEVER_A_TEMPLATE_VARIABLE.includes(key)) continue;
		if (typeof value === 'string' && value.length > LONGEST_TEMPLATE_VALUE) continue;
		safe[key] = value;
	}

	return safe;
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
/**
 * Which kind of note an item becomes.
 *
 * `clipping` preserves the page: the material is the point, and the note's body
 * is whatever the page said. `link` curates a pointer to it: no material, an
 * annotation and a status instead. A page that did not arrive has nothing to
 * preserve, so it can only honestly be a link — see `noteKindFor`.
 */
export type NoteKind = 'clipping' | 'link';

/** The class each kind binds, and the value written to `type`. */
const NOTE_CLASS: Record<NoteKind, string> = {
	clipping: 'Note/Clipping/Web',
	link: 'Note/Link',
};

/** A fresh capture, in the vocabulary both classes start from. */
const INITIAL_STATUS = 'captured';

/**
 * The kind an item actually becomes: what was asked for, unless the page never
 * arrived, in which case a link is the only honest answer — a clipping with no
 * clipped material would claim to preserve something it does not have.
 */
export function noteKindFor(asked: NoteKind, status: ImportStatus): NoteKind {
	return status === 'unresolved' ? 'link' : asked;
}

/**
 * A UUIDv7, which every note carries as the identity assigned at its creation:
 * 48 bits of millisecond timestamp, the version and variant, and random for the
 * rest, so ids sort by when they were made.
 */
export function uuidv7(now = Date.now(), random = () => Math.floor(Math.random() * 256)): string {
	const bytes = new Uint8Array(16);
	let stamp = now;
	for (let i = 5; i >= 0; i--) {
		bytes[i] = stamp % 256;
		stamp = Math.floor(stamp / 256);
	}
	for (let i = 6; i < 16; i++) bytes[i] = random();
	bytes[6] = 0x70 | (bytes[6] & 0x0f);
	bytes[8] = 0x80 | (bytes[8] & 0x3f);

	const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `YYYY-MM-DDTHH:mm:ss` in local time, the form the timestamp fields take. */
export function localTimestamp(when: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
		+ `T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

export interface NoteIdentity {
	/** The note's name, which its filename follows. */
	title: string;
	uid: string;
	/** When this import ran. */
	now: Date;
}

/**
 * The note's frontmatter, holding only what the note's own class declares plus
 * the identity every note carries. Facts the class has no field for are left
 * out rather than invented: a key no class declares is a key nothing reads.
 */
export function readingListFrontMatter(
	item: ReadingListItem,
	status: ImportStatus,
	extracted: Record<string, unknown> = {},
	kind: NoteKind = 'clipping',
	identity: NoteIdentity = { title: '', uid: '', now: new Date() },
): FrontMatterCache {
	const actual = noteKindFor(kind, status);
	const description = item.previewText ?? text(extracted.description) ?? '';
	const author = text(extracted.author);

	const frontMatter: Record<string, unknown> = {
		title: identity.title || readingListTitle(item, text(extracted.title)),
		description,
		type: NOTE_CLASS[actual],
		uid: identity.uid || uuidv7(identity.now.getTime()),
		// The note is as old as the day Safari saved the page, which is also the
		// creation time written to the file itself.
		created: item.dateAdded ?? localTimestamp(identity.now),
		modified: localTimestamp(identity.now),
		status: INITIAL_STATUS,
		tags: [],
		url: item.url,
	};

	if (actual === 'clipping') {
		// Clipping's own fields: provenance, who it is from, when it was captured.
		const source = item.siteName ?? text(extracted.site);
		if (source) frontMatter.source = source;
		if (author) frontMatter.author = [author];
		frontMatter.clipped = localTimestamp(identity.now);
	}
	else {
		if (author) frontMatter.author = [author];
		frontMatter.rating = '';
		frontMatter.read = Boolean(item.dateLastViewed);
		// A link's own status machine starts here too, and the paired clipping it
		// may gain later is declared empty rather than absent.
		frontMatter.clipping = '';
	}

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

/**
 * A link note's body, in the shape the vault's own link notes take: the title
 * and description rendered from the note's own properties, the reason this
 * resource is here, then the status machine, the two inputs and the key. The
 * headings are what matters — a blueprint keeps the rendered blocks in step
 * afterwards — but writing them as the population has them means an imported
 * link is indistinguishable from one made by hand.
 */
export function linkMarkdown(item: ReadingListItem, whyItMatters: string): string {
	return [
		'# `VIEW[\\[{title}\\]({url})][text(renderMarkdown)]`',
		'',
		'`VIEW[*{description}*][text(renderMarkdown)]`',
		'',
		'---',
		'',
		'## Why it matters',
		'',
		whyItMatters,
		'',
		'---',
		'',
		'``VIEW[## Status: `{status}`][text(renderMarkdown)]``',
		'',
		'```js-engine',
		'const mod = await engine.importJs("00-09 System/00 System management/00.13 Scripts/generated/state-machine.js");',
		'return await mod.render(engine, app, context, component, container, { prop: "status", diagram: false, statusText: false });',
		'```',
		'',
		'| **Usefulness** | `INPUT[slider(addLabels, minValue(1), maxValue(5), stepSize(1)):rating]` |',
		'| -------------- | ------------------------------------------------------------------------ |',
		'| **Read**       | `INPUT[toggle:read]`                                                     |',
		'',
		'`BUTTON[convert-to-clipping]`',
		'',
		'---',
		'',
		'### Status key',
		'',
		'| State       | Meaning                                                       |',
		'| ----------- | ---------------------------------------------------- |',
		'| captured    | Just added, not yet reviewed.                                 |',
		'| clarified   | Has real annotation — not just a bare URL.                    |',
		'| reviewed    | Re-checked: target still resolves, still says what\'s claimed. |',
		'| updated     | Reviewed, then the target changed since.                      |',
		'| superseded  | A better resource has replaced this one.                      |',
		'| unavailable | Target no longer resolves.                                    |',
		'| archived    | Converted to a paired Clipping; kept for provenance only.     |',
		'',
		'```meta-bind-button',
		'id: convert-to-clipping',
		'label: Convert to clipping…',
		'icon: scissors',
		'style: default',
		'hidden: true',
		'tooltip: "Fetch this URL via Defuddle and archive this link as a paired clipping"',
		'actions:',
		'  - type: inlineJS',
		'    code: |',
		'      await app.plugins.plugins.quickadd.api.executeChoice("Convert link to clipping…", {});',
		'```',
		'',
	].join('\n');
}

/**
 * Why a link note is here, said plainly. An item Safari could show something
 * about keeps that; one whose page never arrived says so, because that is the
 * fact a reader needs before following it.
 */
export function whyThisLink(item: ReadingListItem, failure?: string): string {
	const preview = item.previewText ? item.previewText.replace(/\s+/gu, ' ').trim() : '';
	const reason = failure
		? `Saved from the Safari reading list. The page could not be fetched when this note was made: ${failure}.`
		: 'Saved from the Safari reading list.';

	return preview ? `${preview}\n\n${reason}` : reason;
}
