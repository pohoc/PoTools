export type PasswordStrengthLevel = 'very-weak' | 'weak' | 'fair' | 'strong' | 'very-strong';
export type PasswordStrengthTip = 'length' | 'variety' | 'common' | 'repeated';

export interface PasswordStrengthAssessment {
  level: PasswordStrengthLevel;
  score: number;
  length: number;
  tips: PasswordStrengthTip[];
}

const COMMON_PASSWORDS = [
  'password', 'passw0rd', 'admin', 'welcome', 'letmein', 'qwerty', 'iloveyou',
  'monkey', 'dragon', '123456', '123456789', 'abc123', '111111', '000000',
];
const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export function assessPasswordStrength(password: string): PasswordStrengthAssessment {
  const length = [...password].length;
  if (!password) return { level: 'very-weak', score: 0, length: 0, tips: ['length', 'variety'] };

  const lower = /[a-z]/.test(password);
  const upper = /[A-Z]/.test(password);
  const digits = /\d/.test(password);
  const symbols = /[^\p{L}\p{N}]/u.test(password);
  const unicode = /[^\x00-\x7F]/.test(password);
  const classCount = [lower, upper, digits, symbols, unicode].filter(Boolean).length;
  const normalized = password.toLowerCase();
  const common = COMMON_PASSWORDS.some((candidate) => normalized.includes(candidate));
  const repeated = /^(.)\1+$/u.test(password) || /(.)\1{3,}/u.test(password);
  const sequential = SEQUENCES.some((sequence) => {
    for (let size = 4; size <= sequence.length; size += 1) {
      for (let start = 0; start + size <= sequence.length; start += 1) {
        const part = sequence.slice(start, start + size);
        if (normalized.includes(part) || normalized.includes([...part].reverse().join(''))) return true;
      }
    }
    return false;
  });

  let score = length >= 20 ? 4 : length >= 14 ? 3 : length >= 10 ? 2 : length >= 8 ? 1 : 0;
  if (classCount >= 4 && length >= 10) score += 1;
  if (classCount === 1) score -= 1;
  if (common) score = 0;
  else if (repeated || sequential) score = Math.min(score, 1);
  score = Math.max(0, Math.min(4, score));

  const tips: PasswordStrengthTip[] = [];
  if (length < 14) tips.push('length');
  if (classCount < 3) tips.push('variety');
  if (common) tips.push('common');
  if (repeated || sequential) tips.push('repeated');
  const levels: PasswordStrengthLevel[] = ['very-weak', 'weak', 'fair', 'strong', 'very-strong'];
  return { level: levels[score]!, score, length, tips };
}
