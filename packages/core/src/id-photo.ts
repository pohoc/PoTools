export interface IdPhotoSize {
  labelKey: string;
  descriptionKey: string;
  widthMm: number;
  heightMm: number;
  width: number;
  height: number;
  dpi?: number;
  fileLabel: string;
}

export const ID_PHOTO_SIZES = {
  'one-inch': {
    labelKey: 'opt.idPhoto.oneInch',
    descriptionKey: 'opt.idPhoto.oneInch.hint',
    widthMm: 25,
    heightMm: 35,
    width: 295,
    height: 413,
    fileLabel: '1-inch',
  },
  'small-one-inch': {
    labelKey: 'opt.idPhoto.smallOneInch',
    descriptionKey: 'opt.idPhoto.smallOneInch.hint',
    widthMm: 22,
    heightMm: 32,
    width: 260,
    height: 378,
    fileLabel: 'small-1-inch',
  },
  'large-one-inch': {
    labelKey: 'opt.idPhoto.largeOneInch',
    descriptionKey: 'opt.idPhoto.largeOneInch.hint',
    widthMm: 33,
    heightMm: 48,
    width: 390,
    height: 567,
    fileLabel: 'large-1-inch',
  },
  'small-two-inch': {
    labelKey: 'opt.idPhoto.smallTwoInch',
    descriptionKey: 'opt.idPhoto.smallTwoInch.hint',
    widthMm: 33,
    heightMm: 48,
    width: 390,
    height: 567,
    fileLabel: 'small-2-inch',
  },
  'china-entry-exit': {
    labelKey: 'opt.idPhoto.chinaEntryExit',
    descriptionKey: 'opt.idPhoto.chinaEntryExit.hint',
    widthMm: 33,
    heightMm: 48,
    width: 390,
    height: 567,
    fileLabel: 'china-entry-exit',
  },
  'china-visa': {
    labelKey: 'opt.idPhoto.chinaVisa',
    descriptionKey: 'opt.idPhoto.chinaVisa.hint',
    widthMm: 33,
    heightMm: 48,
    width: 390,
    height: 567,
    fileLabel: 'china-visa',
  },
  'china-id-card': {
    labelKey: 'opt.idPhoto.chinaIdCard',
    descriptionKey: 'opt.idPhoto.chinaIdCard.hint',
    widthMm: 26,
    heightMm: 32,
    width: 358,
    height: 441,
    dpi: 350,
    fileLabel: 'china-id-card',
  },
  'china-driving-license': {
    labelKey: 'opt.idPhoto.chinaDrivingLicense',
    descriptionKey: 'opt.idPhoto.chinaDrivingLicense.hint',
    widthMm: 22,
    heightMm: 32,
    width: 260,
    height: 378,
    fileLabel: 'china-driving-license',
  },
  'two-inch': {
    labelKey: 'opt.idPhoto.twoInch',
    descriptionKey: 'opt.idPhoto.twoInch.hint',
    widthMm: 35,
    heightMm: 49,
    width: 413,
    height: 579,
    fileLabel: '2-inch',
  },
  'large-two-inch': {
    labelKey: 'opt.idPhoto.largeTwoInch',
    descriptionKey: 'opt.idPhoto.largeTwoInch.hint',
    widthMm: 35,
    heightMm: 53,
    width: 413,
    height: 626,
    fileLabel: 'large-2-inch',
  },
  'china-law-qualification': {
    labelKey: 'opt.idPhoto.chinaLawQualification',
    descriptionKey: 'opt.idPhoto.chinaLawQualification.hint',
    widthMm: 35,
    heightMm: 53,
    width: 413,
    height: 626,
    fileLabel: 'china-law-qualification',
  },
  'three-by-four': {
    labelKey: 'opt.idPhoto.threeByFour',
    descriptionKey: 'opt.idPhoto.threeByFour.hint',
    widthMm: 30,
    heightMm: 40,
    width: 354,
    height: 472,
    fileLabel: '3x4-cm',
  },
  'uk-passport': {
    labelKey: 'opt.idPhoto.ukPassport',
    descriptionKey: 'opt.idPhoto.ukPassport.hint',
    widthMm: 35,
    heightMm: 45,
    width: 413,
    height: 531,
    fileLabel: 'uk-passport',
  },
  'schengen-visa': {
    labelKey: 'opt.idPhoto.schengenVisa',
    descriptionKey: 'opt.idPhoto.schengenVisa.hint',
    widthMm: 35,
    heightMm: 45,
    width: 413,
    height: 531,
    fileLabel: 'schengen-visa',
  },
  'japan-visa': {
    labelKey: 'opt.idPhoto.japanVisa',
    descriptionKey: 'opt.idPhoto.japanVisa.hint',
    widthMm: 35,
    heightMm: 45,
    width: 413,
    height: 531,
    fileLabel: 'japan-visa',
  },
  'india-passport': {
    labelKey: 'opt.idPhoto.indiaPassport',
    descriptionKey: 'opt.idPhoto.indiaPassport.hint',
    widthMm: 35,
    heightMm: 45,
    width: 413,
    height: 531,
    fileLabel: 'india-passport',
  },
  'australia-passport': {
    labelKey: 'opt.idPhoto.australiaPassport',
    descriptionKey: 'opt.idPhoto.australiaPassport.hint',
    widthMm: 35,
    heightMm: 45,
    width: 413,
    height: 531,
    fileLabel: 'australia-passport',
  },
  'canada-passport': {
    labelKey: 'opt.idPhoto.canadaPassport',
    descriptionKey: 'opt.idPhoto.canadaPassport.hint',
    widthMm: 50,
    heightMm: 70,
    width: 591,
    height: 827,
    fileLabel: 'canada-passport',
  },
  'bangladesh-passport': {
    labelKey: 'opt.idPhoto.bangladeshPassport',
    descriptionKey: 'opt.idPhoto.bangladeshPassport.hint',
    widthMm: 45,
    heightMm: 55,
    width: 531,
    height: 650,
    fileLabel: 'bangladesh-passport',
  },
  'bangladesh-visa': {
    labelKey: 'opt.idPhoto.bangladeshVisa',
    descriptionKey: 'opt.idPhoto.bangladeshVisa.hint',
    widthMm: 38,
    heightMm: 48,
    width: 449,
    height: 567,
    fileLabel: 'bangladesh-visa',
  },
  'us-visa': {
    labelKey: 'opt.idPhoto.usVisa',
    descriptionKey: 'opt.idPhoto.usVisa.hint',
    widthMm: 51,
    heightMm: 51,
    width: 600,
    height: 600,
    fileLabel: 'us-visa',
  },
} as const satisfies Record<string, IdPhotoSize>;

export type IdPhotoSizeId = keyof typeof ID_PHOTO_SIZES;

export function getIdPhotoSize(id: unknown): IdPhotoSize {
  return typeof id === 'string' && Object.hasOwn(ID_PHOTO_SIZES, id)
    ? ID_PHOTO_SIZES[id as IdPhotoSizeId]
    : ID_PHOTO_SIZES['one-inch'];
}

export function getIdPhotoPrintSize(id: unknown): { width: number; height: number } {
  const size = getIdPhotoSize(id);
  return {
    width: Math.round((size.widthMm / 25.4) * 300),
    height: Math.round((size.heightMm / 25.4) * 300),
  };
}
