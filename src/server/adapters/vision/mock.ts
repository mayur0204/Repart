import "server-only";
import { createHash } from "node:crypto";
import type { CategoryResult, DamageResult, OcrResult, VisionImage, VisionProvider } from "./types";

export type MockVisionFixture = { category?: CategoryResult; damage?: DamageResult; ocr?: OcrResult };

export const MOCK_VISION_MODEL_VERSION = "mock-vision-1";

export const imageHash = (image: VisionImage) => createHash("sha256").update(image.bytes).digest("hex");

/**
 * Deterministic by image hash. Seed images register expected outputs as fixtures;
 * any other image gets a neutral, zero-confidence answer so it routes to human review.
 */
export function createMockVisionProvider(fixtures: Record<string, MockVisionFixture> = {}): VisionProvider {
  const lookup = (image: VisionImage) => fixtures[imageHash(image)];
  const modelVersion = MOCK_VISION_MODEL_VERSION;
  return {
    name: "mock",
    async classifyCategory(image) {
      return lookup(image)?.category ?? { categorySlug: null, confidence: 0, modelVersion };
    },
    async detectDamage(image) {
      return lookup(image)?.damage ?? { damage: [], confidence: 0, modelVersion };
    },
    async ocr(image) {
      return lookup(image)?.ocr ?? { text: [], confidence: 0, modelVersion };
    },
  };
}
