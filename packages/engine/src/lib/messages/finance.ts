import type { DomainMessages } from '../messages.ts';

export const financeMessages: DomainMessages = {
  'zh-CN': {
    'finance.error.empty': '请输入要转换的金额。',
    'finance.error.format': '金额格式无法识别。请按所选方向输入阿拉伯数字金额或中文大写金额。',
    'finance.error.range': '金额超出支持范围，整数部分最多支持 16 位。',
    'finance.result.uppercase': '人民币大写金额',
    'finance.result.number': '数字金额',
  },
  en: {
    'finance.error.empty': 'Enter an amount to convert.',
    'finance.error.format': 'The amount format was not recognized. Enter an Arabic-number or Chinese uppercase amount for the selected direction.',
    'finance.error.range': 'The amount is outside the supported range. Up to 16 integer digits are supported.',
    'finance.result.uppercase': 'RMB uppercase amount',
    'finance.result.number': 'Numeric amount',
  },
};
