/**
 * Ideal Interface Profiles — Research-backed attention targets per persona
 *
 * Defines the ideal attention distribution, structural constraints, and
 * cognitive thresholds for each persona. Used by the gap score calculator
 * to measure how well a page serves a specific user type.
 *
 * Also defines intent presets that modify attention weights based on
 * user goals (learn, buy, support, compare, explore, signup).
 *
 * @version 1.0.0
 * @since v18.60.0
 */
// ── Ideal Profiles ──
export const IDEAL_PROFILES = [
    {
        persona: 'cognitive-adhd',
        attentionTargets: {
            cta: { min: 30, max: 60, ideal: 45 },
            heading: { min: 15, max: 30, ideal: 20 },
            navigation: { min: 0, max: 15, ideal: 5 },
            content: { min: 5, max: 20, ideal: 10 },
            decorative: { min: 0, max: 5, ideal: 0 },
            search: { min: 0, max: 10, ideal: 5 },
        },
        structure: {
            maxNavItems: 5,
            maxCTAsAboveFold: 1,
            maxContentBlockWords: 40,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 0,
            requireColorRedundancy: false,
            minTouchTarget: 44,
            maxInformationDensity: 0.3,
        },
        thresholds: {
            maxCTC: 0.6,
            maxAbandonmentRisk: 40,
            maxDecisionComplexity: 0.3,
            maxReadabilityCost: 0.4,
        },
        research: [
            'Barkley 1997',
            'Castellanos & Tannock 2002',
            'Sonuga-Barke 2005',
        ],
    },
    {
        persona: 'autism-spectrum',
        attentionTargets: {
            cta: { min: 15, max: 35, ideal: 25 },
            heading: { min: 20, max: 40, ideal: 30 },
            navigation: { min: 10, max: 25, ideal: 15 },
            content: { min: 15, max: 30, ideal: 20 },
            decorative: { min: 0, max: 3, ideal: 0 },
            search: { min: 5, max: 15, ideal: 10 },
        },
        structure: {
            maxNavItems: 7,
            maxCTAsAboveFold: 2,
            maxContentBlockWords: 80,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 0,
            requireColorRedundancy: true,
            minTouchTarget: 44,
            maxInformationDensity: 0.4,
        },
        thresholds: {
            maxCTC: 0.7,
            maxAbandonmentRisk: 50,
            maxDecisionComplexity: 0.4,
            maxReadabilityCost: 0.5,
        },
        research: [
            'Baron-Cohen 2009',
            'Happ\u00e9 & Frith 2006',
            'Kandalaft et al. 2013',
        ],
    },
    {
        persona: 'motor-impairment-tremor',
        attentionTargets: {
            cta: { min: 20, max: 40, ideal: 30 },
            heading: { min: 15, max: 30, ideal: 20 },
            navigation: { min: 5, max: 20, ideal: 10 },
            content: { min: 10, max: 25, ideal: 15 },
            decorative: { min: 0, max: 10, ideal: 5 },
            search: { min: 5, max: 15, ideal: 10 },
        },
        structure: {
            maxNavItems: 5,
            maxCTAsAboveFold: 2,
            maxContentBlockWords: 100,
            requireVisibleLabels: true,
            requirePredictableLayout: false,
            maxAnimations: 5,
            requireColorRedundancy: false,
            minTouchTarget: 48,
            maxInformationDensity: 0.5,
        },
        thresholds: {
            maxCTC: 0.8,
            maxAbandonmentRisk: 50,
            maxDecisionComplexity: 0.5,
            maxReadabilityCost: 0.6,
        },
        research: [],
    },
    {
        persona: 'first-timer',
        attentionTargets: {
            cta: { min: 25, max: 50, ideal: 35 },
            heading: { min: 20, max: 35, ideal: 25 },
            navigation: { min: 10, max: 25, ideal: 15 },
            content: { min: 10, max: 20, ideal: 15 },
            decorative: { min: 0, max: 15, ideal: 5 },
            search: { min: 0, max: 10, ideal: 5 },
        },
        structure: {
            maxNavItems: 7,
            maxCTAsAboveFold: 2,
            maxContentBlockWords: 80,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 3,
            requireColorRedundancy: false,
            minTouchTarget: 44,
            maxInformationDensity: 0.5,
        },
        thresholds: {
            maxCTC: 0.8,
            maxAbandonmentRisk: 50,
            maxDecisionComplexity: 0.5,
            maxReadabilityCost: 0.6,
        },
        research: [],
    },
    {
        persona: 'impatient-user',
        attentionTargets: {
            cta: { min: 40, max: 70, ideal: 55 },
            heading: { min: 10, max: 20, ideal: 15 },
            navigation: { min: 0, max: 10, ideal: 5 },
            content: { min: 0, max: 10, ideal: 5 },
            decorative: { min: 0, max: 5, ideal: 0 },
            search: { min: 10, max: 25, ideal: 15 },
        },
        structure: {
            maxNavItems: 3,
            maxCTAsAboveFold: 1,
            maxContentBlockWords: 20,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 0,
            requireColorRedundancy: false,
            minTouchTarget: 44,
            maxInformationDensity: 0.2,
        },
        thresholds: {
            maxCTC: 0.5,
            maxAbandonmentRisk: 30,
            maxDecisionComplexity: 0.2,
            maxReadabilityCost: 0.3,
        },
        research: [],
    },
    {
        persona: 'elderly-user',
        attentionTargets: {
            cta: { min: 20, max: 40, ideal: 30 },
            heading: { min: 20, max: 35, ideal: 25 },
            navigation: { min: 10, max: 25, ideal: 20 },
            content: { min: 10, max: 25, ideal: 15 },
            decorative: { min: 0, max: 5, ideal: 2 },
            search: { min: 0, max: 10, ideal: 5 },
        },
        structure: {
            maxNavItems: 5,
            maxCTAsAboveFold: 2,
            maxContentBlockWords: 60,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 0,
            requireColorRedundancy: true,
            minTouchTarget: 48,
            maxInformationDensity: 0.3,
        },
        thresholds: {
            maxCTC: 0.7,
            maxAbandonmentRisk: 45,
            maxDecisionComplexity: 0.4,
            maxReadabilityCost: 0.4,
        },
        research: [],
    },
    {
        persona: 'low-vision-magnified',
        attentionTargets: {
            cta: { min: 20, max: 40, ideal: 30 },
            heading: { min: 20, max: 40, ideal: 30 },
            navigation: { min: 5, max: 20, ideal: 10 },
            content: { min: 5, max: 20, ideal: 10 },
            decorative: { min: 0, max: 5, ideal: 0 },
            search: { min: 5, max: 15, ideal: 10 },
        },
        structure: {
            maxNavItems: 5,
            maxCTAsAboveFold: 2,
            maxContentBlockWords: 60,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 0,
            requireColorRedundancy: true,
            minTouchTarget: 48,
            maxInformationDensity: 0.3,
        },
        thresholds: {
            maxCTC: 0.8,
            maxAbandonmentRisk: 50,
            maxDecisionComplexity: 0.5,
            maxReadabilityCost: 0.5,
        },
        research: [],
    },
    {
        persona: 'dyslexic-user',
        attentionTargets: {
            cta: { min: 20, max: 40, ideal: 30 },
            heading: { min: 25, max: 40, ideal: 30 },
            navigation: { min: 5, max: 20, ideal: 10 },
            content: { min: 5, max: 15, ideal: 10 },
            decorative: { min: 0, max: 10, ideal: 5 },
            search: { min: 5, max: 15, ideal: 10 },
        },
        structure: {
            maxNavItems: 5,
            maxCTAsAboveFold: 2,
            maxContentBlockWords: 40,
            requireVisibleLabels: true,
            requirePredictableLayout: true,
            maxAnimations: 1,
            requireColorRedundancy: false,
            minTouchTarget: 44,
            maxInformationDensity: 0.3,
        },
        thresholds: {
            maxCTC: 0.7,
            maxAbandonmentRisk: 45,
            maxDecisionComplexity: 0.4,
            maxReadabilityCost: 0.3,
        },
        research: [],
    },
];
// ── Intent Presets ──
export const INTENT_PRESETS = [
    {
        id: 'learn',
        name: 'Learn / Research',
        description: 'User wants to understand a topic, read documentation, or educate themselves',
        elementModifiers: {
            cta: 0.3,
            heading: 1.8,
            navigation: 1.3,
            content: 1.5,
            price: 0.2,
            search: 1.0,
            form: 0.3,
            trust: 0.5,
        },
        keywordPatterns: ['how', 'what is', 'learn', 'understand', 'about', 'documentation', 'guide', 'tutorial'],
    },
    {
        id: 'buy',
        name: 'Purchase / Convert',
        description: 'User intends to buy a product or complete a transaction',
        elementModifiers: {
            cta: 2.0,
            heading: 0.8,
            navigation: 0.5,
            content: 0.3,
            price: 2.0,
            search: 0.5,
            form: 1.5,
            trust: 1.8,
        },
        keywordPatterns: ['buy', 'purchase', 'price', 'pricing', 'order', 'checkout', 'add to cart', 'shop'],
    },
    {
        id: 'support',
        name: 'Get Help / Support',
        description: 'User is looking for help, troubleshooting, or customer support',
        elementModifiers: {
            cta: 0.5,
            heading: 1.0,
            navigation: 1.5,
            content: 1.2,
            price: 0.2,
            search: 2.0,
            form: 1.3,
            trust: 0.5,
        },
        keywordPatterns: ['help', 'support', 'contact', 'issue', 'problem', 'fix', 'troubleshoot', 'FAQ'],
    },
    {
        id: 'compare',
        name: 'Compare Options',
        description: 'User is evaluating alternatives and comparing features or prices',
        elementModifiers: {
            cta: 0.5,
            heading: 1.5,
            navigation: 0.8,
            content: 1.2,
            price: 2.0,
            search: 0.5,
            form: 0.3,
            trust: 1.0,
        },
        keywordPatterns: ['compare', 'vs', 'versus', 'difference', 'which', 'best', 'alternative'],
    },
    {
        id: 'explore',
        name: 'Browse / Explore',
        description: 'User is casually browsing without a specific goal',
        elementModifiers: {
            cta: 0.8,
            heading: 1.5,
            navigation: 1.5,
            content: 1.0,
            price: 0.5,
            search: 1.0,
            form: 0.3,
            trust: 0.5,
        },
        keywordPatterns: ['browse', 'explore', 'see', 'look at', 'check out', 'discover'],
    },
    {
        id: 'signup',
        name: 'Sign Up / Register',
        description: 'User wants to create an account or start a free trial',
        elementModifiers: {
            cta: 2.0,
            heading: 1.0,
            navigation: 0.3,
            content: 0.3,
            price: 1.0,
            search: 0.3,
            form: 2.0,
            trust: 1.5,
        },
        keywordPatterns: ['sign up', 'register', 'create account', 'get started', 'join', 'start', 'free trial'],
    },
];
// ── Lookup Functions ──
const profileMap = new Map();
for (const p of IDEAL_PROFILES) {
    profileMap.set(p.persona, p);
}
const intentMap = new Map();
for (const i of INTENT_PRESETS) {
    intentMap.set(i.id, i);
}
/**
 * Get the ideal profile for a persona.
 * Returns undefined if no profile exists for this persona.
 */
export function getIdealProfile(persona) {
    return profileMap.get(persona);
}
/**
 * Detect user intent from goal text by matching keyword patterns.
 * Returns the best-matching intent preset ID, or null if no match.
 */
export function detectIntent(goalText) {
    if (!goalText)
        return null;
    const lower = goalText.toLowerCase();
    let bestId = null;
    let bestScore = 0;
    for (const preset of INTENT_PRESETS) {
        let score = 0;
        for (const pattern of preset.keywordPatterns) {
            if (lower.includes(pattern.toLowerCase())) {
                // Longer patterns are more specific, weight them higher
                score += pattern.length;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestId = preset.id;
        }
    }
    return bestId;
}
/**
 * Get an intent preset by ID.
 * Returns undefined if no preset exists for this ID.
 */
export function getIntentPreset(intentId) {
    return intentMap.get(intentId);
}
//# sourceMappingURL=ideal-profiles.js.map