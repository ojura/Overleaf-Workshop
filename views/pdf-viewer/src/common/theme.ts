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
 * Draw the pages in `theme`'s colors with pdf.js's page colors: pdf.js maps the colors of each
 * page between the theme's text and background color. That applies to images too, unlike the
 * legacy viewer, which changes only the color of black text and lines.
 */
export function applyTheme(viewer: any, theme: Theme) {
    const colors = isPlain(theme) ? null : { background: theme.bgColor, foreground: theme.fontColor };
    viewer.pageColors = colors;
    const pages = viewer.pagesCount ?? 0;
    for (let i = 0; i < pages; i++) {
        const view = viewer.getPageView(i);
        if (view) { view.pageColors = colors; }
    }
    viewer.viewer?.style.setProperty('--page-bg-color', colors?.background ?? 'white');
    viewer.refresh?.();
}
