/** Shared OCR result contracts used by the embedded Worker OCR provider. */
export interface OcrLine { text: string; confidence?: number; box?: [number, number, number, number] }
export interface OcrPageResult { text: string; lines: OcrLine[]; model: string }
