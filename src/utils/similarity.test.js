// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, tokenize, jaccardSimilarity, isSimilar } from './similarity.js';

// ── normalizeText ────────────────────────────────────

describe('normalizeText', () => {
    it('lowercases text', () => {
        assert.equal(normalizeText('Hello WORLD'), 'hello world');
    });

    it('strips punctuation', () => {
        assert.equal(normalizeText('file.js: error!'), 'filejs error');
    });

    it('collapses whitespace', () => {
        assert.equal(normalizeText('  too   many   spaces  '), 'too many spaces');
    });

    it('handles empty string', () => {
        assert.equal(normalizeText(''), '');
    });

    it('handles null/undefined', () => {
        assert.equal(normalizeText(null), '');
        assert.equal(normalizeText(undefined), '');
    });

    it('handles Unicode (Vietnamese)', () => {
        assert.equal(normalizeText('Thiếu kiểm tra NULL!'), 'thiếu kiểm tra null');
    });

    it('handles Unicode (Japanese)', () => {
        assert.equal(normalizeText('エラー処理がない'), 'エラー処理がない');
    });
});

// ── tokenize ─────────────────────────────────────────

describe('tokenize', () => {
    it('splits into word tokens', () => {
        const tokens = tokenize('missing null check in handler');
        assert.deepEqual(tokens, new Set(['missing', 'null', 'check', 'in', 'handler']));
    });

    it('filters single-char tokens', () => {
        const tokens = tokenize('a big error in x');
        // 'a', 'x' are single-char → filtered out; 'in' has 2 chars → kept
        assert.deepEqual(tokens, new Set(['big', 'error', 'in']));
    });

    it('returns empty set for empty input', () => {
        assert.deepEqual(tokenize(''), new Set());
    });

    it('normalizes before tokenizing', () => {
        const tokens = tokenize('Missing NULL Check!');
        assert.deepEqual(tokens, new Set(['missing', 'null', 'check']));
    });
});

// ── jaccardSimilarity ────────────────────────────────

describe('jaccardSimilarity', () => {
    it('returns 1.0 for identical sets', () => {
        const s = new Set(['null', 'check', 'missing']);
        assert.equal(jaccardSimilarity(s, s), 1.0);
    });

    it('returns 1.0 for two empty sets', () => {
        assert.equal(jaccardSimilarity(new Set(), new Set()), 1.0);
    });

    it('returns 0.0 when one set is empty', () => {
        assert.equal(jaccardSimilarity(new Set(['a']), new Set()), 0.0);
    });

    it('returns 0.0 for disjoint sets', () => {
        const a = new Set(['foo', 'bar']);
        const b = new Set(['baz', 'qux']);
        assert.equal(jaccardSimilarity(a, b), 0.0);
    });

    it('computes correct similarity for overlapping sets', () => {
        // {null, check, missing} ∩ {null, guard, missing} = {null, missing}
        // Union = {null, check, missing, guard} = 4
        // J = 2/4 = 0.5
        const a = new Set(['null', 'check', 'missing']);
        const b = new Set(['null', 'guard', 'missing']);
        assert.equal(jaccardSimilarity(a, b), 0.5);
    });

    it('is commutative', () => {
        const a = new Set(['error', 'handler', 'null']);
        const b = new Set(['null', 'check', 'error']);
        assert.equal(jaccardSimilarity(a, b), jaccardSimilarity(b, a));
    });
});

// ── isSimilar ────────────────────────────────────────

describe('isSimilar', () => {
    it('returns similar=true for identical texts', () => {
        const result = isSimilar('missing null check', 'missing null check');
        assert.equal(result.similar, true);
        assert.equal(result.score, 1.0);
    });

    it('returns similar=true for paraphrased findings', () => {
        // "Missing null check in handler" vs "handler lacks null guard"
        // tokens1: {missing, null, check, in, handler}
        // tokens2: {handler, lacks, null, guard}
        // intersection: {null, handler} = 2
        // union: {missing, null, check, in, handler, lacks, guard} = 7
        // J = 2/7 ≈ 0.286 → below 0.7
        const result = isSimilar('Missing null check in handler', 'handler lacks null guard');
        assert.equal(result.similar, false);
        assert.ok(result.score < 0.7);
    });

    it('returns similar=true for close paraphrases', () => {
        // "Missing null check" vs "null check is missing"
        // tokens: {missing, null, check} vs {null, check, is, missing}
        // intersection: {missing, null, check} = 3
        // union: {missing, null, check, is} = 4
        // J = 3/4 = 0.75 → above 0.7
        const result = isSimilar('Missing null check', 'null check is missing');
        assert.equal(result.similar, true);
        assert.equal(result.score, 0.75);
    });

    it('respects custom threshold', () => {
        const result = isSimilar('error in handler', 'error in function', 0.3);
        assert.equal(result.similar, true); // 'error', 'in' shared → 2/4 = 0.5 > 0.3
    });

    it('returns similar=false for different subjects', () => {
        const result = isSimilar('SQL injection in login', 'missing CORS headers');
        assert.equal(result.similar, false);
        assert.equal(result.score, 0.0);
    });

    it('handles empty inputs', () => {
        const result = isSimilar('', '');
        assert.equal(result.similar, true);
        assert.equal(result.score, 1.0);
    });
});
