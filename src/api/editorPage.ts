/** The meta tags of a project's editor page (project/:id), which hold the editor's settings. */
export function editorPageMeta(html: string): Record<string, string> {
    const meta: Record<string, string> = {};
    for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
        const name = /\bname="(ol-[^"]+)"/.exec(tag)?.[1];
        if (!name) { continue; }
        const content = /\bcontent="([^"]*)"/.exec(tag)?.[1] ?? '';
        meta[name] = content.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    return meta;
}

/** A TeX Live image that Overleaf offers for projects, from the editor page's ol-imageNames. */
export interface OfferedImage {
    /** e.g. texlive-full:2026.1 */
    imageName: string;
    /** e.g. "2026" or "2021 (Legacy)" */
    imageDesc?: string;
    /** whether this account's projects may use it */
    allowed?: boolean;
    hasCheckpointing?: boolean;
    rolling?: boolean;
    monthlyExperimental?: boolean;
}

/** The images in the editor page's meta tag ol-imageNames, newest first as Overleaf lists them. */
export function offeredImages(meta: Record<string, string>): OfferedImage[] {
    try {
        const list = JSON.parse(meta['ol-imageNames'] ?? '[]');
        return Array.isArray(list) ? list.filter(image => typeof image?.imageName === 'string') : [];
    } catch {
        return [];
    }
}

/** "texlive-full:2025.1" as its family and version numbers: texlive-full, [2025, 1]. */
function imageVersion(imageName: string): { family: string, version: number[] } | undefined {
    const match = /^([^:]+):(\d+(?:\.\d+)*)$/.exec(imageName);
    return match ? { family: match[1], version: match[2].split('.').map(Number) } : undefined;
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0) { return d; }
    }
    return 0;
}

/**
 * The offered images that are newer than `current`: of the same family, with a higher
 * version, allowed for this account, and neither rolling nor experimental. Newest first.
 */
export function newerImages(current: string | undefined, offered: OfferedImage[]): OfferedImage[] {
    const base = current ? imageVersion(current) : undefined;
    if (!base) { return []; }
    return offered
        .filter(image => image.allowed !== false && !image.rolling && !image.monthlyExperimental)
        .filter(image => {
            const version = imageVersion(image.imageName);
            return version !== undefined && version.family === base.family && compareVersions(version.version, base.version) > 0;
        })
        .sort((a, b) => compareVersions(imageVersion(b.imageName)!.version, imageVersion(a.imageName)!.version));
}
