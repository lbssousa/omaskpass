use std::ffi::OsStr;

use serde::Serialize;

use crate::text::{MAX_PROMPT_BYTES, MAX_PROMPT_LINES, sanitize_prompt, sanitize_prompt_within};

/// Protocol version spoken with the plugin; a plugin from another version
/// rejects the request instead of misreading the answer.
pub const PROTOCOL_VERSION: u32 = 3;

/// What OpenSSH wants from this call, from `SSH_ASKPASS_PROMPT` and, for
/// questions, the prompt itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// No hint: ask for a passphrase or PIN and print it.
    Passphrase,
    /// `confirm` (ssh-agent with `ssh-add -c`): exit 0 allows, anything else denies.
    Confirm,
    /// `none` (e.g. "Confirm user presence for key …"): show the message
    /// until OpenSSH kills us with SIGTERM.
    Notify,
    /// No hint, but one of OpenSSH's own yes/no questions (see
    /// [`split_question`]): ask with the answer visible and print it.
    Text,
}

/// Last lines of the questions OpenSSH asks about host keys before
/// connecting. The text above them names the host and its key.
const QUESTION_ENDINGS: &[&str] = &[
    "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
    "Are you sure you want to continue connecting (yes/no)?",
];

/// Questions OpenSSH asks on their own: again after an answer it didn't
/// take, and for `UpdateHostKeys=ask`. They end in ':' like passphrase
/// prompts, and a key's path (which may hold a newline) comes right
/// before that ':', so only the whole prompt counts.
const QUESTIONS: &[&str] = &[
    "Please type 'yes', 'no' or the fingerprint:",
    "Please type 'yes' or 'no':",
    "Accept updated hostkeys? (yes/no):",
];

/// OpenSSH asks these with `RP_ECHO`, which never reaches the askpass: it
/// gets no hint, the same as for a passphrase. So they're told apart by
/// their text: a prompt ending in one of [`QUESTION_ENDINGS`] (no
/// passphrase or PIN prompt ends in '?'), or exactly one of
/// [`QUESTIONS`]. Returns the text above the question and the question.
fn split_question(prompt: &str) -> Option<(&str, &'static str)> {
    let prompt = prompt.trim_end();
    if let Some(question) = QUESTIONS.iter().find(|q| **q == prompt) {
        return Some(("", question));
    }
    let (above, last) = prompt.rsplit_once('\n').unwrap_or(("", prompt));
    let question = QUESTION_ENDINGS.iter().find(|q| **q == last)?;
    Some((above, question))
}

impl Mode {
    /// Anything but the two hints OpenSSH sends is a passphrase request,
    /// which is the only mode that never grants anything without the user
    /// typing.
    pub fn from_prompt_hint(hint: Option<&OsStr>) -> Mode {
        match hint.and_then(OsStr::to_str) {
            Some("confirm") => Mode::Confirm,
            Some("none") => Mode::Notify,
            _ => Mode::Passphrase,
        }
    }

    /// Turns a passphrase request into [`Mode::Text`] when the prompt is
    /// one of OpenSSH's yes/no questions; other modes stay as they are.
    pub fn for_prompt(self, prompt: &str) -> Mode {
        match self {
            Mode::Passphrase if split_question(prompt).is_some() => Mode::Text,
            mode => mode,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Passphrase => "passphrase",
            Mode::Confirm => "confirm",
            Mode::Notify => "notify",
            Mode::Text => "text",
        }
    }
}

/// The prompt of a question, cleaned. The question itself is our own
/// literal and always makes it to the last line, however long the text
/// above it: a host key prompt can list a dozen other names for the key.
fn question_prompt(prompt: &str) -> String {
    let Some((above, question)) = split_question(prompt) else {
        return sanitize_prompt(prompt);
    };
    let mut out = sanitize_prompt_within(
        above,
        MAX_PROMPT_LINES - 1,
        MAX_PROMPT_BYTES - question.len() - 1,
    );
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(question);
    out
}

#[derive(Serialize)]
struct Request<'a> {
    v: u32,
    mode: &'static str,
    prompt: &'a str,
}

/// The prompt as the dialog gets it: cleaned (see [`sanitize_prompt`]),
/// with a question kept whole on the last line.
pub fn shown_prompt(mode: Mode, prompt: &str) -> String {
    match mode {
        Mode::Text => question_prompt(prompt),
        _ => sanitize_prompt(prompt),
    }
}

/// One NDJSON request line for the plugin, with the [`shown_prompt`]; the
/// JSON encoding keeps it on one line.
pub fn encode_request(mode: Mode, prompt: &str) -> Vec<u8> {
    let prompt = shown_prompt(mode, prompt);
    let req = Request {
        v: PROTOCOL_VERSION,
        mode: mode.as_str(),
        prompt: &prompt,
    };
    // Serializing a struct of strings can't fail.
    let mut line = serde_json::to_vec(&req).expect("request serializes");
    line.push(b'\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn mode_from_hint() {
        assert_eq!(Mode::from_prompt_hint(None), Mode::Passphrase);
        assert_eq!(
            Mode::from_prompt_hint(Some(OsStr::new("confirm"))),
            Mode::Confirm
        );
        assert_eq!(
            Mode::from_prompt_hint(Some(OsStr::new("none"))),
            Mode::Notify
        );
    }

    #[test]
    fn unknown_hints_ask_for_a_passphrase() {
        for hint in ["", "CONFIRM", "None", " none", "confirm ", "whatever", "0"] {
            assert_eq!(
                Mode::from_prompt_hint(Some(OsStr::new(hint))),
                Mode::Passphrase,
                "{hint:?}"
            );
        }
        let not_utf8 = OsStr::from_bytes(b"conf\xFFirm");
        assert_eq!(Mode::from_prompt_hint(Some(not_utf8)), Mode::Passphrase);
    }

    #[test]
    fn mode_names_match_the_plugin() {
        assert_eq!(Mode::Passphrase.as_str(), "passphrase");
        assert_eq!(Mode::Confirm.as_str(), "confirm");
        assert_eq!(Mode::Notify.as_str(), "notify");
        assert_eq!(Mode::Text.as_str(), "text");
    }

    const HOST_KEY_PROMPT: &str = "The authenticity of host 'h (192.0.2.1)' can't be established.\n\
        ED25519 key fingerprint is: SHA256:abc.\n\
        Are you sure you want to continue connecting (yes/no/[fingerprint])? ";

    #[test]
    fn openssh_questions_are_asked_as_text() {
        for prompt in [
            HOST_KEY_PROMPT,
            "Warning: the ED25519 host key for 'h' differs from the key for the IP address '192.0.2.1'\n\
             Offending key for IP in /k:3\n\
             Are you sure you want to continue connecting (yes/no)? ",
            "Please type 'yes', 'no' or the fingerprint: ",
            "Please type 'yes' or 'no': ",
            "Accept updated hostkeys? (yes/no): ",
        ] {
            assert_eq!(
                Mode::Passphrase.for_prompt(prompt),
                Mode::Text,
                "{prompt:?}"
            );
        }
    }

    #[test]
    fn a_question_inside_a_passphrase_prompt_stays_secret() {
        // Key paths come right before the final ':' and may hold newlines.
        for prompt in [
            "Enter passphrase for key '/k\nPlease type 'yes' or 'no'': ",
            "Enter passphrase for /k\nAccept updated hostkeys? (yes/no): ",
            "Enter passphrase for /k (yes/no)?: ",
            "Enter passphrase for key '/k\nAre you sure you want to continue connecting (yes/no)?': ",
            "Enter PIN for ED25519-SK key /Please type 'yes' or 'no': ",
            "Please type 'yes' or 'no' ",
            "Are you sure you want to continue connecting (yes/no)? x",
            "",
        ] {
            assert_eq!(
                Mode::Passphrase.for_prompt(prompt),
                Mode::Passphrase,
                "{prompt:?}"
            );
        }
    }

    #[test]
    fn hints_win_over_the_prompt() {
        assert_eq!(Mode::Confirm.for_prompt(HOST_KEY_PROMPT), Mode::Confirm);
        assert_eq!(Mode::Notify.for_prompt(HOST_KEY_PROMPT), Mode::Notify);
    }

    #[test]
    fn a_question_keeps_its_last_line_whatever_comes_before() {
        let others = (1..=12)
            .map(|n| format!("    ~/.ssh/known_hosts:{n}: other{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "The authenticity of host 'h (192.0.2.1)' can't be established.\n\
             ED25519 key fingerprint is: SHA256:abc.\n\
             This host key is known by the following other names/addresses:\n\
             {others}\n\
             Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        );
        let line = encode_request(Mode::Text, &prompt);
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let shown = v["prompt"].as_str().unwrap();
        assert_eq!(shown.lines().count(), crate::text::MAX_PROMPT_LINES);
        assert!(shown.starts_with("The authenticity of host 'h (192.0.2.1)'"));
        assert!(
            shown.ends_with(
                "\nAre you sure you want to continue connecting (yes/no/[fingerprint])?"
            )
        );

        let long = format!(
            "{}\nAre you sure you want to continue connecting (yes/no)?",
            "x".repeat(10_000)
        );
        let line = encode_request(Mode::Text, &long);
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let shown = v["prompt"].as_str().unwrap();
        assert_eq!(shown.len(), crate::text::MAX_PROMPT_BYTES);
        assert!(shown.ends_with("\nAre you sure you want to continue connecting (yes/no)?"));
    }

    #[test]
    fn a_question_alone_is_shown_alone() {
        let line = encode_request(Mode::Text, "Please type 'yes' or 'no': ");
        assert_eq!(
            line,
            b"{\"v\":3,\"mode\":\"text\",\"prompt\":\"Please type 'yes' or 'no':\"}\n"
        );
    }

    #[test]
    fn the_text_above_a_question_is_cleaned() {
        let line = encode_request(
            Mode::Text,
            "host '\u{202E}evil'\r\n\n\nAre you sure you want to continue connecting (yes/no)?",
        );
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(
            v["prompt"],
            "host 'evil'\nAre you sure you want to continue connecting (yes/no)?"
        );
    }

    #[test]
    fn request_line() {
        let line = encode_request(Mode::Notify, "Confirm user presence for key");
        assert_eq!(
            line,
            b"{\"v\":3,\"mode\":\"notify\",\"prompt\":\"Confirm user presence for key\"}\n"
        );
    }

    #[test]
    fn request_is_a_single_line_whatever_the_prompt_holds() {
        let line = encode_request(Mode::Confirm, "a\nb\r\nc\u{2028}d\"\\e\u{0}");
        assert_eq!(line.iter().filter(|&&b| b == b'\n').count(), 1);
        assert_eq!(line.last(), Some(&b'\n'));
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(v["prompt"], "a\nb\ncd\"\\e");
        assert_eq!(
            (v["v"].as_u64(), v["mode"].as_str()),
            (Some(3), Some("confirm"))
        );
    }

    #[test]
    fn request_prompt_is_sanitized_and_bounded() {
        let long = "x".repeat(10_000);
        let line = encode_request(Mode::Passphrase, &format!("\u{202E}{long}"));
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let prompt = v["prompt"].as_str().unwrap();
        assert!(!prompt.contains('\u{202E}'));
        assert_eq!(prompt.len(), crate::text::MAX_PROMPT_BYTES);
    }
}
