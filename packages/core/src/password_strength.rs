//! Deterministic password strength scoring used by both the UI and engine.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PasswordStrengthLevel {
    VeryWeak,
    Weak,
    Fair,
    Strong,
    VeryStrong,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PasswordStrengthTip {
    Length,
    Variety,
    Common,
    Repeated,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PasswordStrengthAssessment {
    pub level: PasswordStrengthLevel,
    pub score: u8,
    pub length: usize,
    pub tips: Vec<PasswordStrengthTip>,
}

const COMMON: &[&str] = &[
    "password",
    "passw0rd",
    "admin",
    "welcome",
    "letmein",
    "qwerty",
    "iloveyou",
    "monkey",
    "dragon",
    "123456",
    "123456789",
    "abc123",
    "111111",
    "000000",
];
const SEQUENCES: &[&str] = &[
    "0123456789",
    "abcdefghijklmnopqrstuvwxyz",
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
];

pub fn assess_password_strength(password: &str) -> PasswordStrengthAssessment {
    let length = password.chars().count();
    let mut tips = Vec::new();
    if password.is_empty() {
        return PasswordStrengthAssessment {
            level: PasswordStrengthLevel::VeryWeak,
            score: 0,
            length: 0,
            tips: vec![PasswordStrengthTip::Length, PasswordStrengthTip::Variety],
        };
    }
    let lower = password.chars().any(char::is_lowercase);
    let upper = password.chars().any(char::is_uppercase);
    let digits = password.chars().any(char::is_numeric);
    let symbols = password.chars().any(|c| !c.is_alphanumeric());
    let unicode = password.chars().any(|c| !c.is_ascii());
    let classes = [lower, upper, digits, symbols, unicode]
        .into_iter()
        .filter(|v| *v)
        .count();
    let normalized = password.to_lowercase();
    let common = COMMON
        .iter()
        .any(|candidate| normalized.contains(candidate));
    let chars: Vec<char> = password.chars().collect();
    let repeated = chars.windows(2).all(|pair| pair[0] == pair[1])
        || chars
            .windows(4)
            .any(|window| window.iter().all(|c| *c == window[0]));
    let sequential = SEQUENCES
        .iter()
        .any(|sequence| has_sequence(&normalized, sequence));
    let mut score: u8 = match length {
        20.. => 4,
        14.. => 3,
        10.. => 2,
        8.. => 1,
        _ => 0,
    };
    if classes >= 4 && length >= 10 {
        score += 1;
    }
    if classes == 1 {
        score = score.saturating_sub(1);
    }
    if common {
        score = 0;
    } else if repeated || sequential {
        score = score.min(1);
    }
    score = score.min(4);
    if length < 14 {
        tips.push(PasswordStrengthTip::Length);
    }
    if classes < 3 {
        tips.push(PasswordStrengthTip::Variety);
    }
    if common {
        tips.push(PasswordStrengthTip::Common);
    }
    if repeated || sequential {
        tips.push(PasswordStrengthTip::Repeated);
    }
    let level = [
        PasswordStrengthLevel::VeryWeak,
        PasswordStrengthLevel::Weak,
        PasswordStrengthLevel::Fair,
        PasswordStrengthLevel::Strong,
        PasswordStrengthLevel::VeryStrong,
    ][score as usize];
    PasswordStrengthAssessment {
        level,
        score,
        length,
        tips,
    }
}

fn has_sequence(haystack: &str, sequence: &str) -> bool {
    let chars: Vec<char> = sequence.chars().collect();
    for size in 4..=chars.len() {
        for start in 0..=chars.len() - size {
            let part: String = chars[start..start + size].iter().collect();
            let reverse: String = part.chars().rev().collect();
            if haystack.contains(&part) || haystack.contains(&reverse) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use PasswordStrengthLevel as L;
    use PasswordStrengthTip as T;

    fn tips_of(password: &str) -> Vec<PasswordStrengthTip> {
        assess_password_strength(password).tips
    }

    #[test]
    fn empty_password_floors_out() {
        let a = assess_password_strength("");
        assert_eq!((a.level, a.score, a.length), (L::VeryWeak, 0, 0));
        assert_eq!(a.tips, vec![T::Length, T::Variety]);
    }

    #[test]
    fn common_passwords_score_zero() {
        let a = assess_password_strength("My-passw0rd-2026");
        assert_eq!(a.level, L::VeryWeak);
        assert_eq!(a.score, 0);
        assert!(tips_of("My-passw0rd-2026").contains(&T::Common));
    }

    #[test]
    fn repetition_caps_score() {
        let a = assess_password_strength("aaaaaaaa");
        assert!(a.score <= 1);
        assert!(tips_of("aaaaaaaa").contains(&T::Repeated));
        let seq = assess_password_strength("zxcvb12345");
        assert!(seq.score <= 1);
        assert!(tips_of("zxcvb12345").contains(&T::Repeated));
    }

    #[test]
    fn long_varied_passphrase_tops_out() {
        let a = assess_password_strength("CorrectHorse7!x");
        assert_eq!(a.level, L::VeryStrong);
        assert!(tips_of("CorrectHorse7!x").is_empty());
    }

    #[test]
    fn short_single_class_stays_weak() {
        let a = assess_password_strength("abcdef");
        assert_eq!(a.level, L::VeryWeak);
        assert!(tips_of("abcdef").contains(&T::Length));
        assert!(tips_of("abcdef").contains(&T::Variety));
    }

    #[test]
    fn length_counts_chars_not_bytes() {
        assert_eq!(
            assess_password_strength("密码密码密码密码密码密码密码").length,
            14
        );
    }
}
