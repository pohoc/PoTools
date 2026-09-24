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

declare module 'jpeg-js' {
  const jpeg: {
    encode(image: { data: Uint8Array; width: number; height: number }, quality?: number): {
      data: Uint8Array;
      width: number;
      height: number;
    };
  };
  export default jpeg;
}
