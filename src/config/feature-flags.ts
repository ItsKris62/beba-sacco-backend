/**
 * Global Feature Flags
 * Configured via Environment Variables (Render/Netlify)
 */
export const ENABLE_PRODUCT_RULES_ENGINE = process.env.ENABLE_PRODUCT_RULES === 'true';

// Documentation:
// To enable the dynamic Daraja/Jipange limits logic, set ENABLE_PRODUCT_RULES=true
// If false or undefined, the system falls back to the MVP hardcoded 3x global multiplier.
