// @ts-check
/**
 * Text Similarity Utilities
 *
 * Provides fuzzy text comparison for finding deduplication.
 * Uses Jaccard similarity on word-level token sets.
 *
 * @module utils/similarity
 */

// ── Text Normalization ───────────────────────────────

/**
 * Normalize text for similarity comparison.
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '') // strip non-letter, non-number, non-space (Unicode-safe)
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Tokenization ─────────────────────────────────────

/**
 * Split normalized text into word-level tokens.
 * Filters out empty strings and very short tokens (≤1 char).
 *
 * @param {string} text - Should be normalized first
 * @returns {Set<string>}
 */
export function tokenize(text) {
    const normalized = normalizeText(text);
    if (!normalized) return new Set();
    return new Set(
        normalized
            .split(' ')
            .filter(t => t.length > 1) // skip single-char noise
    );
}

// ── Jaccard Similarity ───────────────────────────────

/**
 * Compute Jaccard similarity between two token sets.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} 0.0 to 1.0
 */
export function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1.0; // both empty = identical
    if (setA.size === 0 || setB.size === 0) return 0.0; // one empty = no similarity

    let intersection = 0;
    // Iterate on the smaller set for efficiency
    const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const token of smaller) {
        if (larger.has(token)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return intersection / union;
}

// ── Convenience API ──────────────────────────────────

/**
 * Check if two texts are similar above a threshold.
 *
 * @param {string} text1
 * @param {string} text2
 * @param {number} [threshold=0.7] - Minimum similarity (0.0 to 1.0)
 * @returns {{ similar: boolean, score: number }}
 */
export function isSimilar(text1, text2, threshold = 0.7) {
    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);
    const score = jaccardSimilarity(tokens1, tokens2);
    return { similar: score >= threshold, score };
}
