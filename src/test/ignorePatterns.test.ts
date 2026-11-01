import * as assert from 'assert';
import { minimatch } from 'minimatch';
import { DEFAULT_IGNORE_PATTERNS, IgnoreMatcher } from '../scm/ignorePatterns';

// The local replica matches every path of its folder against its ignore patterns at each
// listing: the patterns are compiled once for each value of the setting, not once per path.
describe('the local replica\'s ignore patterns', () => {
    it('are compiled once for each value of the patterns, and again when the value changes', () => {
        const matcher = new IgnoreMatcher();
        const compiled = matcher.matchers(DEFAULT_IGNORE_PATTERNS);
        assert.strictEqual(compiled.length, DEFAULT_IGNORE_PATTERNS.length);
        assert.strictEqual(matcher.matchers([...DEFAULT_IGNORE_PATTERNS]), compiled, 'the same value in another array');
        const patterns = [...DEFAULT_IGNORE_PATTERNS];
        const again = matcher.matchers(patterns);
        assert.strictEqual(again, compiled, 'the same value again');
        // the setting's array can change in place, as the settings' list does with push and splice
        patterns.push('**/*.tmp');
        const changed = matcher.matchers(patterns);
        assert.notStrictEqual(changed, compiled, 'the value changed in place');
        assert.strictEqual(changed.length, DEFAULT_IGNORE_PATTERNS.length + 1);
        assert.strictEqual(matcher.matchers(patterns), changed, 'the changed value again');
    });

    it('match as minimatch matches each pattern, dot files included', () => {
        const matcher = new IgnoreMatcher();
        const patterns = [...DEFAULT_IGNORE_PATTERNS, '# a comment matches nothing', '/build/**', '**/figures/*.pdf'];
        const paths = ['/main.tex', '/main.aux', '/sub/main.aux', '/.git', '/.vscode/settings.json', '/sub/.hidden', '/main.pdf',
            '/output.pdf', '/a.synctex(busy)', '/build/x.pdf', '/figures/a.pdf', '/x/figures/a.pdf', '/figures/a.png',
            '/chapter.log', '/__latexindent_temp.tex', '/# a comment matches nothing', '/main.run.xml'];
        for (const p of paths) {
            assert.strictEqual(matcher.matches(patterns, p), patterns.some(pattern => minimatch(p, pattern, { dot: true })), p);
        }
    });
});
