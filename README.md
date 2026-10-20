# omaskpass

[![ci](https://github.com/lbssousa/omaskpass/actions/workflows/ci.yml/badge.svg)](https://github.com/lbssousa/omaskpass/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lbssousa/omaskpass/badge)](https://scorecard.dev/viewer/?uri=github.com/lbssousa/omaskpass)

An SSH Askpass dialog for the Omarchy shell, styled like the polkit agent.
It asks for passphrases and FIDO PINs, asks OpenSSH's yes/no host key
questions, confirms `ssh-add -c` key uses, and shows security key touch
requests, in the same overlay as the shell's polkit agent.

omaskpass was called **ssh-askpass-omarchy** until 0.2.0. The binary,
socket, environment variable (`SSH_ASKPASS_OMARCHY_SOCKET` →
`OMASKPASS_SOCKET`) and shell plugin (`lbssousa.ssh_askpass` →
`lbssousa.omaskpass`) were renamed with it; see
[CHANGELOG.md](CHANGELOG.md) for upgrading.

## How it works

This consists of two parts:
1. An Omarchy (Quickshell) plugin (`lbssousa.omaskpass`) that listens on a UNIX socket for passphrase requests and displays the UI dialog.
2. A Rust binary (`omaskpass`) that is executed by OpenSSH. It receives the prompt message as an argument, forwards it to the plugin's socket via JSON, waits for the user input, and outputs the resulting passphrase to stdout.

## Modes

OpenSSH tells the askpass what it wants through `SSH_ASKPASS_PROMPT`:

| `SSH_ASKPASS_PROMPT` | When | Dialog | Result |
|---|---|---|---|
| unset | passphrases, FIDO PINs (`Enter PIN for … key …`) | password field | passphrase on stdout |
| unset, prompt is a yes/no question | unknown host keys (`Are you sure you want to continue connecting (yes/no/[fingerprint])?`), `UpdateHostKeys=ask` | plain text field | answer on stdout |
| `confirm` | ssh-agent using a key added with `ssh-add -c` | **Deny** / **Allow** (Enter does not allow) | exit 0 allows, exit 1 denies |
| `none` | notifications, e.g. `Confirm user presence for key …` | **Touch your security key** card for user-presence prompts; a message with **Dismiss** otherwise | OpenSSH kills the askpass (SIGTERM) when it's done, which closes the dialog |

OpenSSH asks its yes/no questions with the answer echoed, but that
never reaches the askpass: it gets no hint, as for a passphrase. So the
binary recognizes them by their text: a prompt whose last line is
`Are you sure you want to continue connecting (yes/no/[fingerprint])?` or
`… (yes/no)?`, or a prompt that is exactly `Please type 'yes' or 'no':`,
`Please type 'yes', 'no' or the fingerprint:` or
`Accept updated hostkeys? (yes/no):`. Passphrase and PIN prompts end in
`:` right after a key path, which may hold a newline, so `:` questions
only count as the whole prompt. The question always stays on the card's
last line, however many other names for the key OpenSSH lists above it.

The touch dialog shows up only when OpenSSH runs the askpass, never for other
FIDO uses such as WebAuthn in a browser. If ssh-agent does the signing, it
needs `SSH_ASKPASS` in its environment too. Agents that don't run an askpass
(Proton Pass, for example) show nothing.

Stock OpenSSH also prints the touch request to the terminal, instead of
running the askpass, whenever ssh runs in one, even with
`SSH_ASKPASS_REQUIRE=prefer`.

### Protocol between the two halves (v3)

Request: `{"v":3,"mode":"passphrase"|"text"|"confirm"|"notify","prompt":"…"}`

Response: `{"result":"ok"|"cancel"|"busy"|"error","password"?,"message"?}`.
`password` (percent-encoded) is only sent in `passphrase` and `text`
modes; in `text` mode it holds the answer to the question. The plugin
refuses other protocol versions and unknown modes.

### Security notes

See [SECURITY.md](SECURITY.md) for the threat model and how to report a
vulnerability. In short:

- **Memory:** the binary locks its memory (`mlockall`) and turns off core
  dumps and ptrace (non-dumpable). Every copy of the passphrase it makes
  lives in a zeroized buffer: the socket read buffer and the decoded
  passphrase. It writes to stdout unbuffered, so no stdio buffer keeps it.
- **Socket:** it lives in the user's 0700 runtime directory, and the
  binary checks that the listening peer runs as the same user.
- **Confirmations fail closed:** only a literal `ok` allows. **Deny** is
  the default button and Enter never allows.
- **Displayed text:** the prompt is stripped of control characters,
  text-reordering and zero-width characters, limited in size, and rendered
  as plain text, never rich text.
- **Questions in plain text:** a server's keyboard-interactive prompts
  (`(user@host) …`) reach the askpass without a hint too, and the server
  writes them. One can end in an OpenSSH question line and get a visible
  field. What's typed there goes to that server anyway.
- **Inside omarchy-shell:** the passphrase goes through a QML `TextInput`
  and the JavaScript heap, which can't be wiped. The field is cleared as
  soon as the answer is sent. This is the same trade-off as the polkit
  dialog.

## Environment Variables

To use this with SSH, you need to set the `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE` variables.
```bash
export SSH_ASKPASS=/path/to/omaskpass
export SSH_ASKPASS_REQUIRE=prefer
```

## Development

| Recipe | What it does |
|---|---|
| `just test` | Unit tests, integration tests against a fake dialog, `cargo fmt --check` and clippy |
| `just test-plugin` | Protocol tests against the real QML plugin in a throwaway Quickshell instance (needs the Wayland session; dialogs flash on screen) |
| `just fuzz [target] [secs]` | Fuzzes the reply parser, the prompt cleaner or the passphrase decoder with cargo-fuzz (needs nightly Rust and `cargo install cargo-fuzz`) |
| `just dev` | Runs the dialog in a separate Quickshell instance (`dev/`, which links the shell's `Commons`/`Ui`) on its own socket |
| `just try [mode]` | Sends a sample `passphrase`, `confirm`, `hostkey` or `touch` request through the `just dev` instance |

## Releases

`main` only takes squash-merged pull requests, which GitHub signs with its
own key. A release is therefore a **GPG-signed tag** made by the maintainer
on the merged commit. Check one with `git verify-tag vX.Y.Z` after
importing the maintainer's public key.

1. Open a PR that bumps the version in `Cargo.toml` (then run
   `cargo update -w`) and `plugin/manifest.json`.
   The same PR turns the "Unreleased" section of
   [CHANGELOG.md](CHANGELOG.md) into the new version's release notes.
   Merge it.
2. Tag the merge commit and push the tag:
   ```sh
   git switch main && git pull
   git tag -s vX.Y.Z -m "omaskpass X.Y.Z"
   git push origin vX.Y.Z
   ```

## Feedback and contributing

- **Bugs and feature requests:** [GitHub issues](https://github.com/lbssousa/omaskpass/issues).
- **Security vulnerabilities:** report them privately, as described in
  [SECURITY.md](SECURITY.md).
- **Contributions:** pull requests are welcome. See
  [CONTRIBUTING.md](CONTRIBUTING.md) for the rules: tests with every change,
  signed commits, and CI passing.
- **Release notes:** [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
