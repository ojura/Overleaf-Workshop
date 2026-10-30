import type { InitState } from './host';

/** A color theme of the setting overleaf-workshop.pdfViewer.themes. */
export interface Theme {
    name: string;
    fontColor: string;
    bgColor: string;
}

/** the themes of the legacy viewer (views/pdf-viewer/index.js), when the setting has none */
const DEFAULT_THEMES: Record<string, { fontColor: string, bgColor: string }> = {
    'default': { fontColor: 'black', bgColor: 'white' },
    'light': { fontColor: 'black', bgColor: '#F5F5DC' },
    'dark': { fontColor: '#FBF0D9', bgColor: '#4B4B4B' },
};

const COLOR = /^(#[0-9a-fA-F]{6}|black|white)$/;

/** The themes that the host sent, without the names and colors that are not safe to use. */
export function themesFrom(init: Pick<InitState, 'colorThemes'>): Theme[] {
    const themes = Object.entries(init.colorThemes ?? DEFAULT_THEMES)
        .filter(([name, colors]) => /^[a-zA-Z0-9-_]+$/.test(name) && COLOR.test(colors?.fontColor) && COLOR.test(colors?.bgColor))
        .map(([name, colors]) => ({ name, fontColor: colors.fontColor, bgColor: colors.bgColor }));
    return themes.length ? themes : themesFrom({ colorThemes: DEFAULT_THEMES });
}

const isPlain = (theme: Theme) => /^(black|#000000)$/i.test(theme.fontColor) && /^(white|#ffffff)$/i.test(theme.bgColor);

/**
 * Draw the pages in `theme`'s colors, as the legacy viewer does. The extension's patch to pdf.js
 * (vendor/pdfjs-5.1.91-dist.patch) reads globalThis.pdfjsViewerColorTheme whenever it draws a
 * page: black text and lines outside form XObjects take the theme's text color, and the page's
 * background the theme's background color. Images and colored content keep their colors, which
 * pdf.js's own page colors would map too.
 */
export function applyTheme(viewer: any, theme: Theme) {
    (globalThis as any).pdfjsViewerColorTheme = isPlain(theme) ? null : { fontColor: theme.fontColor, bgColor: theme.bgColor };
    viewer.pageColors = null;
    viewer.viewer?.style.setProperty('--page-bg-color', isPlain(theme) ? 'white' : theme.bgColor);
    // draws the pages again, which reads the theme anew
    viewer.refresh?.();
}
