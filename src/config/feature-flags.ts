/**
 * Global Feature Flags
 * Configured via Environment Variables (Render/Netlify)
 */
export const ENABLE_PRODUCT_RULES_ENGINE = process.env.ENABLE_PRODUCT_RULES === 'true';

// Documentation:
// ENABLE_PRODUCT_RULES is fail-fast validated at startup. It must be true so
// dynamic product rules override the old MVP hardcoded multiplier behavior.
