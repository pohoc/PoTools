/** Build identity injected by `vite.config.ts` (see `src/lib/version.ts`). */
declare const __APP_VERSION__: string;
declare const __BUILD_STAMP__: string;
declare const __DISPLAY_VERSION__: string;
declare module '*?url' {
  const assetUrl: string;
  export default assetUrl;
}

declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'utif' {
  export interface TiffIfd {
    width?: number;
    height?: number;
    data?: Uint8Array;
    [tag: `t${number}`]: number[] | undefined;
  }
  const UTIF: {
    decode(buffer: ArrayBuffer): TiffIfd[];
    decodeImage(buffer: ArrayBuffer, ifd: TiffIfd, ifds?: TiffIfd[]): void;
    toRGBA8(ifd: TiffIfd): Uint8Array;
    encode(ifds: TiffIfd[]): ArrayBuffer;
  };
  export default UTIF;
}
