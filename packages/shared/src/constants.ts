/** System-wide constants shared by API and frontends. */

/** Identifier of the SIMULATED feature extractor + template scheme stamped on every descriptor. */
export const ALGO_ID = 'palmwallet-sim-hog-v1';
export const ALGO_VERSION = '1.0.0';

/**
 * Descriptor dimensionality: pyramid HOG (global + 2x2 quadrant cells x 32
 * orientation bins) AFTER population mean-centering (see extractor.ts).
 */
export const DESCRIPTOR_DIM = 160;
/** Per-cell normalization exponent: 0 = unit-norm cells, 1 = raw magnitudes. */
export const CELL_NORM_BETA = 0;
/** Population-mean sample count and the capture parameters it is averaged under. */
export const POPULATION_MEAN_SAMPLES = 192;
export const POPULATION_MEAN_SEED_NS = 'palm-wallet-population-mean-v2';
/** Protected template size in bits after random projection + sign binarization.
 *  This — not a feature descriptor — is the only biometric artifact that ever
 *  crosses the network: capture devices protect scans locally before upload. */
export const TEMPLATE_BITS = 1024;
/** Byte length of a packed protected code on the wire (TEMPLATE_BITS / 8). */
export const TEMPLATE_BYTES = TEMPLATE_BITS / 8;
/** Device-attested enrollment repeatability floor (min pairwise frame cosine). */
export const ENROLL_CONSISTENCY_FLOOR = 0.5;

/**
 * Similarity = 1 - hamming/bits. >= MATCH_THRESHOLD -> match.
 * Calibrated on the synthetic population (docs/BIOMETRICS.md): genuine
 * probe-vs-enroll similarity >= ~0.91 across 64 identities; impostor
 * similarity p99.9 ~= 0.78 with worst observed pair 0.854.
 */
export const MATCH_THRESHOLD = 0.86;
/** Below this a definitive no-match; [floor, threshold) is the grey zone —
 *  settlement still refused, reported distinctly as low confidence. */
export const MATCH_GREY_FLOOR = 0.76;
/** Two best candidates from different subjects both above threshold and within this margin -> ambiguous. */
export const AMBIGUITY_MARGIN = 0.02;

/** Requests older/newer than this vs server clock are stale (replay protection). */
export const FRESHNESS_WINDOW_MS = 5 * 60_000;

export const MIN_PAYMENT_PIASTERS = 100; // EGP 1.00
export const MAX_PAYMENT_PIASTERS = 50_000_00; // EGP 50,000.00
export const MIN_DEPOSIT_PIASTERS = 500; // EGP 5.00
export const MAX_DEPOSIT_PIASTERS = 10_000_00; // EGP 10,000.00

/** Frames averaged into one enrollment descriptor. */
export const ENROLL_FRAMES_REQUIRED = 7;
/** Frames averaged into a verification probe (POS scan / self-test). */
export const PROBE_FRAMES_REQUIRED = 5;

/** Egyptian mobile numbers: +20 followed by 1[0125] and 8 digits. */
export const PHONE_REGEX = /^\+201[0125]\d{8}$/;
/** Account passwords: any characters, minimum 6 (stored only as SHA-256 hashes). */
export const PASSWORD_REGEX = /^[\s\S]{6,128}$/;

export const CURRENCY = 'EGP' as const;
