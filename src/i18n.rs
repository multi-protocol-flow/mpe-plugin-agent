//! Lightweight UI-language helper for the Agent plugin.

use mpe_plugin_sdk::prelude::locale;

/// Picks the Chinese or English text based on the injected `MPE_LOCALE`.
pub fn t(zh: &'static str, en: &'static str) -> &'static str {
    pick(zh, en, locale().as_deref())
}

fn pick(zh: &'static str, en: &'static str, locale: Option<&str>) -> &'static str {
    if locale == Some("zh-CN") {
        zh
    } else {
        en
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_english() {
        assert_eq!(t("中文", "English"), "English");
    }

    #[test]
    fn zh_locale_selects_chinese() {
        assert_eq!(pick("中文", "English", Some("zh-CN")), "中文");
    }

    #[test]
    fn non_matching_locale_falls_back_to_english() {
        assert_eq!(pick("中文", "English", Some("en-US")), "English");
        assert_eq!(pick("中文", "English", Some("fr-FR")), "English");
        assert_eq!(pick("中文", "English", None), "English");
    }
}
