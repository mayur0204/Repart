export type VisionImage = { bytes: Uint8Array; contentType: string };
type Scored = { confidence: number; modelVersion: string };

export type CategoryResult = Scored & { categorySlug: string | null };
export type DamageResult = Scored & { damage: Array<{ kind: "CRACK" | "RUST" | "BEND" | "BURN" | "OTHER"; score: number }> };
export type OcrResult = Scored & { text: string[] };

/** Image classification for risk pipeline stage 2 (REPART_BRIEF.md §6). */
export interface VisionProvider {
  readonly name: string;
  classifyCategory(image: VisionImage): Promise<CategoryResult>;
  detectDamage(image: VisionImage): Promise<DamageResult>;
  ocr(image: VisionImage): Promise<OcrResult>;
}
